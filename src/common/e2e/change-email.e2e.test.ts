/**
 * The address-change flow, end to end.
 *
 * This is the flow that shipped broken: changing an address answered with the
 * sign-up email, the confirmation screen announced an account had just become
 * active, and `check-email-verification` reported success for a change that had
 * never been applied. A fake cannot show any of it, because the bug lived in
 * which of better-auth's branches the configuration sent a request down.
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
  shutdownApp,
  signIn,
} from "./harness";

const PASSWORD = "Password123!";
const NEW_ADDRESS = "new-address@test.invalid";

let fx: E2EFixture;

async function requestChange(cookie: string, newEmail = NEW_ADDRESS) {
  const response = await request(fx.baseUrl)
    .post("/api/auth/change-email")
    .set("Cookie", cookie)
    .send({ newEmail });

  if (response.status !== 200) {
    throw new Error(
      `change-email failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

/** The token the new-address email carries, taken out of its link. */
function linkToken(html: string | undefined): string {
  const match = /token=([^&"']+)/.exec(html ?? "");
  if (!match) {
    throw new Error("the confirmation email carries no link");
  }
  return decodeURIComponent(match[1]);
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

describe.each([
  ["a verified account", true],
  ["an unverified account", false],
])("changing the address of %s", (_label, verified) => {
  async function seed() {
    const user = await createVerifiedUser(
      fx.prisma,
      "user-owner",
      "owner@test.invalid",
      PASSWORD,
    );

    // Signed in first, then un-verified: better-auth refuses to sign an
    // unverified account in at all. That is also the state a default deployment
    // is in — `REQUIRE_EMAIL_VERIFICATION` defaults to false, so nobody ever
    // verified anything and every account sits here.
    const cookie = await signIn(fx.baseUrl, user.email, PASSWORD);

    if (!verified) {
      await fx.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: false },
      });
    }

    return { user, cookie };
  }

  it("emails the new address a confirmation, not an account creation", async () => {
    const { user, cookie } = await seed();

    await requestChange(cookie);

    const toNew = emailsTo(NEW_ADDRESS);
    expect(toNew).toHaveLength(1);
    expect(toNew[0].subject).toBe("Confirm your new email address");
    expect(toNew[0].subject).not.toBe("Verify your email address");
    expect(toNew[0].html).toContain("flow=change-email");

    // Nothing landed in the mailbox of the address being replaced except the
    // heads-up: no sign-up email either.
    expect(emailsTo(user.email).map((mail) => mail.subject)).toEqual([
      "Your email address is being changed",
    ]);
  });

  it("applies the change when the link is opened", async () => {
    const { cookie } = await seed();

    await requestChange(cookie);
    const token = linkToken(emailsTo(NEW_ADDRESS)[0].html);

    // verify-email is a GET: it is the link's destination, not an action.
    const verify = await request(fx.baseUrl).get(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(verify.status).toBe(200);

    const updated = await fx.prisma.user.findUnique({
      where: { id: "user-owner" },
    });
    expect(updated?.email).toBe(NEW_ADDRESS);
    expect(updated?.emailVerified).toBe(true);
  });

  it("reports the flow as unfulfilled until the link is opened", async () => {
    const { cookie } = await seed();

    await requestChange(cookie);
    const token = linkToken(emailsTo(NEW_ADDRESS)[0].html);

    const before = await request(fx.baseUrl).get(
      `/api/auth/check-email-verification?token=${encodeURIComponent(token)}`,
    );
    expect(before.status).toBe(200);
    expect(before.body.verified).toBe(false);

    await request(fx.baseUrl).get(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );

    const after = await request(fx.baseUrl).get(
      `/api/auth/check-email-verification?token=${encodeURIComponent(token)}`,
    );
    expect(after.body.verified).toBe(true);
  });

  it("leaves the address untouched if the link is never opened", async () => {
    const { user, cookie } = await seed();

    await requestChange(cookie);

    const record = await fx.prisma.user.findUnique({ where: { id: user.id } });
    expect(record?.email).toBe(user.email);
  });
});
