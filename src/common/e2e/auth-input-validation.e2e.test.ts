/**
 * The body rules better-auth never sees.
 *
 * `inputValidationHook` runs before every auth endpoint and rejects malformed
 * fields itself, so the codes a client branches on come from *this* repository
 * rather than from the library. That is the point of the file it lives in — and
 * it had no test: `input-validation.ts` sat at 81 %, and the codes were a promise
 * nobody checked.
 *
 * Each case below is a field the hook is meant to answer, asked for on the
 * endpoint that carries it, because the mapping from endpoint to fields is part
 * of what can break: a path added to the table with the wrong validator fails
 * quietly, and a path left out of the table fails openly, one field at a time.
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
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
  signIn,
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

function signUp(body: Record<string, unknown>) {
  return request(fx.baseUrl).post("/api/auth/sign-up/email").send(body);
}

const valid = {
  name: "Camille",
  email: "reader@validation.test",
  password: PASSWORD,
};

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
});

describe("the fields the hook validates", () => {
  it("refuses a password below the bound, with the code a client branches on", async () => {
    const response = await signUp({ ...valid, password: "Court1!" });

    // The `code` is the contract: the frontend matches on it, and the message is
    // the part a person reads. A rejection without a stable code is a rejection
    // the frontend cannot explain.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PASSWORD_TOO_SHORT_OR_LONG");
    // Counted for this address: the reset leaves the system's own scaffold rows
    // in place, and they are nobody's account here.
    expect(await fx.prisma.user.count({ where: { email: valid.email } })).toBe(
      0,
    );
  });

  it("refuses a password above the bound too", async () => {
    const response = await signUp({ ...valid, password: "a".repeat(129) });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PASSWORD_TOO_SHORT_OR_LONG");
  });

  it("refuses a name carrying something other than letters", async () => {
    const response = await signUp({ ...valid, name: "Camille <b>" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_NAME");
  });

  it("refuses a profile image that is not https", async () => {
    const response = await signUp({
      ...valid,
      image: "http://example.org/avatar.png",
    });

    // `data:` and `javascript:` images are the reason, and both are refused by
    // the same rule; an http one is refused because it is what a browser would
    // upgrade or block depending on the page it lands on.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_IMAGE");
  });

  it("refuses an email past the RFC bound", async () => {
    const response = await signUp({
      ...valid,
      email: `${"a".repeat(250)}@validation.test`,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_EMAIL");
  });

  it("refuses a redirect carrying a control character", async () => {
    const response = await signUp({
      ...valid,
      callbackURL: "https://app.test/welcome\nSet-Cookie: x=1",
    });

    // The URL's shape is checked here; *which* origin is trusted is better-auth's
    // own rule. A control character in a redirect is a header the reader never
    // asked for.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_CALLBACK_URL");
  });

  it("refuses a redirect past its bound", async () => {
    const response = await signUp({
      ...valid,
      callbackURL: `https://app.test/${"a".repeat(2048)}`,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_CALLBACK_URL");
  });

  it("leaves an optional field that is absent alone", async () => {
    const response = await signUp(valid);

    // The hook skips what was not sent. Treating a missing optional field as a
    // failed validation would make every sign-up in the application fail.
    expect(response.status).toBe(200);
    expect(
      await fx.prisma.user.findUnique({ where: { email: valid.email } }),
    ).not.toBeNull();
  });
});

describe("what the hook normalises on the way through", () => {
  it("stores and queries the address in lower case", async () => {
    const response = await signUp({
      ...valid,
      email: "Reader@Validation.Test",
    });

    expect(response.status).toBe(200);

    // Stored, queried and compared in one form: an account that signs up as
    // `Reader@…` and signs in as `reader@…` is the same person, and a lookup
    // that forgot the case would refuse their own password.
    const stored = await fx.prisma.user.findUniqueOrThrow({
      where: { email: "reader@validation.test" },
    });
    expect(stored.email).toBe("reader@validation.test");

    // A signup leaves the address unverified, and an unverified account cannot
    // sign in at all — so the address is verified before asking whether the
    // case is what stops the reader from getting back in.
    await fx.prisma.user.update({
      where: { id: stored.id },
      data: { emailVerified: true },
    });

    const signInAgain = await request(fx.baseUrl)
      .post("/api/auth/sign-in/email")
      .send({ email: "READER@validation.test", password: PASSWORD });
    expect(signInAgain.status).toBe(200);
  });
});

describe("the endpoint-to-field mapping", () => {
  it("applies the password rule to a sign-in, where it is only bounded", async () => {
    // Sign-in carries `passwordInputSchema`, not `passwordSchema`: the stored
    // password may predate the current policy, so verification is bounded but
    // not strengthened. A test asserting the strength rule here would fail — and
    // rightly so.
    await createVerifiedUser(
      fx.prisma,
      "user-old",
      "old@validation.test",
      PASSWORD,
    );

    const response = await request(fx.baseUrl)
      .post("/api/auth/sign-in/email")
      .send({ email: "old@validation.test", password: "a".repeat(200) });

    expect(response.body.code).toBe("INVALID_PASSWORD");
  });

  it("applies the email rule to a change of address", async () => {
    const user = await createVerifiedUser(
      fx.prisma,
      "user-change",
      "change@validation.test",
      PASSWORD,
    );

    const response = await request(fx.baseUrl)
      .post("/api/auth/change-email")
      .set("Cookie", await signIn(fx.baseUrl, user.email, PASSWORD))
      .send({ newEmail: `${"b".repeat(250)}@validation.test` });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_EMAIL");
  });

  it("applies the token rule to a revocation", async () => {
    const user = await createVerifiedUser(
      fx.prisma,
      "user-revoke",
      "revoke@validation.test",
      PASSWORD,
    );
    const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

    const blank = await request(fx.baseUrl)
      .post("/api/auth/revoke-session")
      .set("Cookie", cookies)
      .send({ token: "   " });

    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe("INVALID_TOKEN");
  });
});
