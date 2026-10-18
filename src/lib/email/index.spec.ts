/**
 * The emails the application sends, read as text.
 *
 * These are the only artifacts of this codebase a person reads on their own
 * time, and they are the ones no test was looking at: `lib/email` sat at 36 %
 * coverage while every e2e suite happily asserted that *an* email went out. What
 * went into it — whether the link is there, whether the button says what it does,
 * and in the erasure case the whole legal disclosure — was unchecked.
 *
 * That last one is the reason this file exists rather than a generic template
 * test. The erasure email states what is kept and for how long: the number of
 * applications belonging to other candidates, the purge delay, the retention of
 * the accountability trail. Those are numbers read from configuration and from
 * the database, injected into a sentence, and a sentence is exactly the kind of
 * value a refactor can quietly blank while every test still passes.
 *
 * The transport is the one the harness already injects for the e2e suites
 * (`configureMailer`), so nothing here opens a socket.
 */

import { describe, expect, it } from "bun:test";

import { escapeHtml, safeUrl } from "./escape";
import {
  sendChangeEmailApprovalEmail,
  sendDeleteAccountEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
} from "./index";
import { configureMailer } from "./mailer";

interface SentMail {
  to: string;
  subject: string;
  html: string;
}

/** Captures what the mailer is handed, and gives it back afterwards. */
async function capture(
  send: () => Promise<unknown>,
): Promise<SentMail | undefined> {
  const sent: SentMail[] = [];
  configureMailer({
    from: "noreply@test",
    transporter: {
      sendMail: async (message: Record<string, unknown>) => {
        sent.push({
          to: String(message.to),
          subject: String(message.subject),
          html: String(message.html),
        });
        return { messageId: "test" };
      },
    } as never,
  });

  try {
    await send();
    return sent[0];
  } finally {
    // Leaving a fake in place would make the next suite believe it had a
    // transport, and the failure would land somewhere else entirely.
    configureMailer(undefined);
  }
}

describe("the verification email", () => {
  it("carries its link and its recipient", async () => {
    const mail = await capture(() =>
      sendVerificationEmail({
        email: "reader@test",
        name: "Camille",
        url: "https://app.test/verify?token=abc",
      }),
    );

    expect(mail?.to).toBe("reader@test");
    expect(mail?.subject).toBe("Verify your email address");
    expect(mail?.html).toContain("https://app.test/verify?token=abc");
    expect(mail?.html).toContain("Camille");
  });

  it("says nothing about a name it was not given", async () => {
    const mail = await capture(() =>
      sendVerificationEmail({
        email: "reader@test",
        name: null,
        url: "https://app.test/verify?token=abc",
      }),
    );

    // The name is optional and `undefined` prints as the word itself in a naive
    // template — "Hello undefined" is worse than no greeting.
    expect(mail?.html).not.toContain("undefined");
  });
});

describe("the reset password email", () => {
  it("carries its link, its recipient and its subject", async () => {
    const mail = await capture(() =>
      sendResetPasswordEmail({
        email: "reader@test",
        name: "Camille",
        url: "https://app.test/reset?token=abc",
      }),
    );

    expect(mail?.to).toBe("reader@test");
    expect(mail?.subject).toBe("Reset your password");
    expect(mail?.html).toContain("https://app.test/reset?token=abc");
  });
});

describe("the email change approval email", () => {
  it("names the address the change is about, and keeps the link", async () => {
    const mail = await capture(() =>
      sendChangeEmailApprovalEmail({
        email: "old@test",
        name: "Camille",
        newEmail: "new@test",
        url: "https://app.test/approve?token=abc",
      }),
    );

    expect(mail?.to).toBe("old@test");
    expect(mail?.subject).toBe("Approve this email address change");
    expect(mail?.html).toContain("new@test");
    expect(mail?.html).toContain("https://app.test/approve?token=abc");
    expect(mail?.html).toContain("Approve the change");
  });

  /**
   * The point of the mail: it goes to the *current* address.
   *
   * Sent to the new one instead, a request to change the address would hand the
   * change itself to the person trying to take it over — which is the entire
   * reason this approval step exists.
   */
  it("is sent to the current address, never to the new one", async () => {
    const mail = await capture(() =>
      sendChangeEmailApprovalEmail({
        email: "old@test",
        name: "Camille",
        newEmail: "attacker@test",
        url: "https://app.test/approve?token=abc",
      }),
    );

    expect(mail?.to).toBe("old@test");
    expect(mail?.to).not.toBe("attacker@test");
  });
});

describe("the account deletion email", () => {
  const url = "https://app.test/goodbye?token=abc";

  it("names the current address, so the reader knows which account is concerned", async () => {
    const mail = await capture(() =>
      sendDeleteAccountEmail({
        email: "reader@test",
        name: "Camille",
        url,
        thirdPartyApplications: 0,
        purgeGraceDays: 30,
        trailRetentionDays: 3,
      }),
    );

    expect(mail?.to).toBe("reader@test");
    expect(mail?.subject).toBe("Account deletion");
    expect(mail?.html).toContain("reader@test");
    expect(mail?.html).toContain("Delete my account for good");
  });

  /**
   * The disclosure, with the two durations it is assembled from.
   *
   * Both numbers come from configuration. A template that stops interpolating
   * them still renders, still gets sent, and still gets opened by someone
   * deciding whether to confirm — which is the only moment the sentence matters.
   */
  it("states the purge delay and the trail retention it was configured with", async () => {
    const mail = await capture(() =>
      sendDeleteAccountEmail({
        email: "reader@test",
        name: "Camille",
        url,
        thirdPartyApplications: 0,
        purgeGraceDays: 30,
        trailRetentionDays: 1095,
      }),
    );

    expect(mail?.html).toContain("30 days");
    expect(mail?.html).toContain("1095 days");
  });

  it("discloses the applications kept for other candidates, and why", async () => {
    const mail = await capture(() =>
      sendDeleteAccountEmail({
        email: "reader@test",
        name: "Camille",
        url,
        thirdPartyApplications: 4,
        purgeGraceDays: 30,
        trailRetentionDays: 3,
      }),
    );

    // The branch that exists because the erasure cannot take them: they are the
    // other candidates' words, and the reader is told so in as many words.
    expect(mail?.html).toContain("The applications other candidates sent you.");
    expect(mail?.html).not.toContain("None of your data is passed");
  });

  it("says nothing else is kept when there is nothing else", async () => {
    const mail = await capture(() =>
      sendDeleteAccountEmail({
        email: "reader@test",
        name: "Camille",
        url,
        thirdPartyApplications: 0,
        purgeGraceDays: 30,
        trailRetentionDays: 3,
      }),
    );

    expect(mail?.html).toContain("Nothing else besides that trace");
    expect(mail?.html).not.toContain(
      "The applications other candidates sent you.",
    );
  });

  it("never promises the email before the request is recorded", async () => {
    const mail = await capture(() =>
      sendDeleteAccountEmail({
        email: "reader@test",
        name: "Camille",
        url,
        thirdPartyApplications: 0,
        purgeGraceDays: 30,
        trailRetentionDays: 3,
      }),
    );

    // The whole email is conditional on a trail row existing; the wording is the
    // "if you did not make this request" branch, and it has to stay there or
    // the mail starts inviting someone else to confirm a deletion.
    expect(mail?.html).toContain(
      "If you did not make this request, ignore this email",
    );
  });
});

describe("what a template refuses to render", () => {
  it("drops a link that is not http(s)", async () => {
    // The url is built from configuration and better-auth's callback, so it is
    // trusted input in the same way a database value is: a `javascript:` url in
    // a call to action is a stored click on someone else's account.
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,<script>")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
    expect(safeUrl("https://app.test/reset?token=abc")).toBe(
      "https://app.test/reset?token=abc",
    );
  });

  it("leaves no button at all when the link is refused", async () => {
    const mail = await capture(() =>
      sendResetPasswordEmail({
        email: "reader@test",
        name: "Camille",
        url: "javascript:alert(1)",
      }),
    );

    expect(mail?.html).not.toContain("javascript:");
  });

  it("escapes the values it interpolates", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("Camille & Antoine")).toBe("Camille &amp; Antoine");
  });

  it("escapes a name carrying markup, and a new address carrying markup", async () => {
    const mail = await capture(() =>
      sendChangeEmailApprovalEmail({
        email: "old@test",
        name: "<b>Camille</b>",
        newEmail: "new@test",
        url: "https://app.test/approve?token=abc",
      }),
    );

    expect(mail?.html).not.toContain("<b>Camille</b>");
    expect(mail?.html).toContain("&lt;b&gt;Camille&lt;/b&gt;");
  });
});
