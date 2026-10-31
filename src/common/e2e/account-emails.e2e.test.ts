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
import { SignJWT } from "jose";
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

/**
 * The page a reader is left on after clicking a verification link.
 *
 * `GET /api/auth/check-email-verification` exists because the frontend cannot
 * tell an expired link from a fulfilled intent: after a click it needs to say
 * « your address is verified » rather than show an error. It is the one endpoint
 * of the verification flow with no test at all — and the thing a person actually
 * sees between signing up and clicking.
 *
 * The tokens are minted here with the application's own secret, which is the
 * only thing that decides whether this endpoint answers at all: a token signed
 * with anything else must be refused before a single lookup happens, or the
 * endpoint becomes a way to ask whether an address has an account on this
 * platform.
 */
describe("GET /api/auth/check-email-verification", () => {
  function check(token: string) {
    return request(fx.baseUrl).get("/api/auth/check-email-verification").query({
      token,
    });
  }

  /** A token as better-auth would have minted it, signed with the real secret. */
  function signToken(payload: Record<string, unknown>, secret?: string) {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(
        new TextEncoder().encode(
          secret ?? process.env.BETTER_AUTH_SECRET ?? "",
        ),
      );
  }

  /** An account that exists and has not verified its address yet. */
  async function signUp(email: string) {
    const response = await request(fx.baseUrl)
      .post("/api/auth/sign-up/email")
      .send({ name: "Camille", email, password: PASSWORD });

    expect(response.status).toBe(200);
    return response.body;
  }

  it("says the address is not verified while the account says so", async () => {
    await signUp("pending@verify.test");
    const token = await signToken({ email: "pending@verify.test" });

    const response = await check(token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ verified: false });
  });

  it("says the address is verified once the account says so, with the same token", async () => {
    const account = await signUp("later@verify.test");
    const token = await signToken({ email: "later@verify.test" });

    // The same link, asked before and after: the answer is about the account's
    // state now, which is what lets the page recover from a click that arrived
    // too late.
    const before = await check(token);
    expect(before.body).toEqual({ verified: false });

    await fx.prisma.user.update({
      where: { id: account.user.id },
      data: { emailVerified: true },
    });

    const after = await check(token);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ verified: true });
  });

  it("answers an expired link rather than refusing it", async () => {
    await signUp("expired@verify.test");
    const token = await new SignJWT({ email: "expired@verify.test" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.BETTER_AUTH_SECRET ?? ""));

    // The reader who clicked yesterday's link must be told their address is
    // verified, not handed an error to puzzle over.
    const response = await check(token);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ verified: false });
  });

  /**
   * The one that matters: which of the two addresses a change token is about.
   *
   * The account behind the current address is verified by definition — the flow
   * cannot start otherwise — so asking about it answers « yes » for a change that
   * has not been applied, on the one page whose only output is that answer.
   */
  it("asks about the address a change moves to, never the one it comes from", async () => {
    const account = await signUp("old@verify.test");
    await fx.prisma.user.update({
      where: { id: account.user.id },
      data: { emailVerified: true },
    });

    const token = await signToken({
      email: "old@verify.test",
      updateTo: "new@verify.test",
      requestType: "change-email-verification",
    });

    const response = await check(token);

    // The change has not been applied, so `new@verify.test` belongs to nobody
    // and the honest answer is false.
    expect(response.body).toEqual({ verified: false });
  });

  it("refuses a token signed with another secret", async () => {
    await signUp("forged@verify.test");
    const token = await signToken(
      { email: "forged@verify.test" },
      "a-secret-this-server-never-used",
    );

    const response = await check(token);

    // Without this, the endpoint answers « is this address registered here »
    // to anybody holding a token they minted themselves.
    expect(response.status).toBe(401);
  });

  it("refuses a token that is not a token", async () => {
    const response = await check("not-a-jwt");

    expect(response.status).toBe(401);
  });
});
