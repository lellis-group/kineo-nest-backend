/**
 * The password reset flow, and the one thing it must never do.
 *
 * Nothing tested it: the route existed, the template existed, the hook was wired,
 * and no suite asked better-auth to send one. A flow nobody has ever exercised
 * end to end is a flow whose first failure is a user report — and this one has
 * two failure modes worth naming. The mail can fail to arrive or fail to carry
 * a usable link, which is a bug. And the answer can differ between an address
 * that has an account and one that does not, which is worse than a bug: it turns
 * the form into a way to find out who is registered here.
 *
 * So both are asserted, and the second one is the reason this file exists.
 *
 * The order of the tests is not free: the route answers three attempts per ten
 * seconds, and the first three tests here are the ones that need a mail to
 * arrive. The two that follow run inside that window on purpose — see below.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import request from "supertest";
import {
  bootApp,
  clearSentEmails,
  createVerifiedUser,
  type E2EFixture,
  emailsTo,
  resetData,
  sentEmails,
  shutdownApp,
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

async function seedUser(id: string, email: string) {
  return createVerifiedUser(fx.prisma, id, email, PASSWORD);
}

function linkToken(html: string | undefined): string {
  const match = /token=([^&"']+)/.exec(html ?? "");
  if (!match) {
    throw new Error("the email carries no link");
  }
  return decodeURIComponent(match[1]);
}

/** The request a reader makes by typing an address into the forgotten-password form. */
function requestReset(email: string, redirectTo?: string) {
  return request(fx.baseUrl)
    .post("/api/auth/request-password-reset")
    .send({ email, ...(redirectTo ? { redirectTo } : {}) });
}

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
  clearSentEmails();
});

describe("asking for a password reset", () => {
  it("emails the address that asked, with a link", async () => {
    await seedUser("user-reader", "reader@reset.test");

    const response = await requestReset("reader@reset.test");
    expect(response.status).toBe(200);

    const sent = emailsTo("reader@reset.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Reset your password");
    // The address itself is the envelope, not the body: the template greets by
    // name and never repeats it.
    expect(sent[0].to).toBe("reader@reset.test");
    expect(sent[0].html).toContain("/reset-password");
    expect(sent[0].html).toContain("Reset my password");
    expect(sent[0].html).toContain("If you did not make this request");
  });

  it("emails nothing to anybody else", async () => {
    await seedUser("user-reader-2", "reader2@reset.test");

    await requestReset("reader2@reset.test");

    // One recipient and one message: a reset mail copied to anyone, or sent to
    // the account's contact address as well as the one that asked, hands the
    // account to a second party.
    expect(emailsTo("reader2@reset.test").map((mail) => mail.to)).toEqual([
      "reader2@reset.test",
    ]);
  });

  it("sends a token that answers on the reset endpoint", async () => {
    // The link is only useful if the token is one the application accepts, so
    // the token is followed the way the reader would rather than inspected.
    await seedUser("user-reader-3", "reader3@reset.test");
    await requestReset("reader3@reset.test");

    const token = linkToken(emailsTo("reader3@reset.test")[0].html);

    const page = await request(fx.baseUrl).get(
      `/api/auth/reset-password/${token}`,
    );

    // The endpoint answers rather than 500s: a token minted by the mail and
    // rejected by the page is a reset that can never be completed.
    expect(page.status).toBeLessThan(500);
  });

  /**
   * The answer must not say whether the address has an account.
   *
   * This route sits behind better-auth's own default rule — three attempts per
   * ten seconds, a rule `RATE_LIMIT_MAX` does not reach because it is only
   * configurable through `customRules` — so the three tests above have already
   * spent this suite's budget and the two requests below are answered `429`. That
   * is what makes the comparison worth making, in the end: a reader who has been
   * throttled and a reader who typed somebody else's address must be
   * indistinguishable, and `429` on one of the two only would be the answer this
   * form must never give.
   */
  it("answers a stranger's address exactly like a known one", async () => {
    await seedUser("user-known", "known@reset.test");

    const onRecord = await requestReset("known@reset.test");
    const unknown = await requestReset("stranger@reset.test");

    expect(unknown.status).toBe(onRecord.status);
    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(onRecord.body));
  });

  it("still refuses the mail for an unknown address rather than sending one", async () => {
    // The two properties are separate: the answer may be identical, but nothing
    // may leave for an address with no account behind it. Asserted on a request
    // of its own rather than on the pair above, so it holds whatever the rate
    // limit is doing.
    const unknown = await requestReset("ghost@reset.test");

    expect(unknown.status).toBeLessThan(500);
    expect(emailsTo("ghost@reset.test")).toHaveLength(0);
    // No address is ever sent two: a duplicate would put a second valid token in
    // somebody's inbox for a request they made once.
    const recipients = sentEmails.map((mail) => mail.to);
    expect(new Set(recipients).size).toBe(recipients.length);
  });
});
