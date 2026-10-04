/**
 * The address-change flow, end to end.
 *
 * This is the flow that shipped broken: changing an address answered with the
 * sign-up email, the confirmation screen announced an account had just become
 * active, and `check-email-verification` reported success for a change that had
 * never been applied. A fake cannot show any of it, because the bug lived in
 * which of better-auth's branches the configuration sent a request down.
 *
 * The flow has two shapes, and better-auth's own rules decide which one runs:
 * a *verified* current address has to approve the change before anything is sent
 * to the new address, while an unverified one — the state every account is in
 * when `REQUIRE_EMAIL_VERIFICATION` is off, which is the shipped default —
 * goes straight to the new address, because an address that was never verified
 * is no proof of anything to gate on.
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
const OLD_ADDRESS = "owner@test.invalid";

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

/** The token an email carries, taken out of its link. */
function linkToken(html: string | undefined): string {
  const match = /token=([^&"']+)/.exec(html ?? "");
  if (!match) {
    throw new Error("the email carries no link");
  }
  return decodeURIComponent(match[1]);
}

/** Opens a link the way a reader would: better-auth's verify-email is a GET. */
function openLink(token: string) {
  return request(fx.baseUrl).get(
    `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
  );
}

/** Whether the flow's intent has been fulfilled, per the backend's own answer. */
async function isFulfilled(token: string) {
  const response = await request(fx.baseUrl).get(
    `/api/auth/check-email-verification?token=${encodeURIComponent(token)}`,
  );
  expect(response.status).toBe(200);
  return response.body.verified;
}

async function currentAddress() {
  const record = await fx.prisma.user.findUnique({
    where: { id: "user-owner" },
  });
  return record?.email;
}

/**
 * Signs in first, then un-verifies the row: better-auth refuses to sign an
 * unverified account in at all.
 */
async function seed(verified: boolean) {
  const user = await createVerifiedUser(
    fx.prisma,
    "user-owner",
    OLD_ADDRESS,
    PASSWORD,
  );
  const cookie = await signIn(fx.baseUrl, user.email, PASSWORD);

  if (!verified) {
    await fx.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: false },
    });
  }

  return { user, cookie };
}

/** The confirmation the new address receives, wherever the flow started. */
async function expectChangeEmailToNewAddress() {
  const toNew = emailsTo(NEW_ADDRESS);
  expect(toNew).toHaveLength(1);
  expect(toNew[0].subject).toBe("Confirm your new email address");
  expect(toNew[0].subject).not.toBe("Verify your email address");
  expect(toNew[0].html).toContain("flow=change-email");
  return linkToken(toNew[0].html);
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

describe("changing the address of a verified account", () => {
  it("asks the current address to approve, and emails nothing else yet", async () => {
    const { cookie } = await seed(true);

    await requestChange(cookie);

    const toOld = emailsTo(OLD_ADDRESS);
    expect(toOld).toHaveLength(1);
    expect(toOld[0].subject).toBe("Approve this email address change");
    expect(toOld[0].html).toContain("flow=change-email-approval");
    expect(emailsTo(NEW_ADDRESS)).toHaveLength(0);
  });

  it("releases the verification to the new address once approved", async () => {
    const { cookie } = await seed(true);

    await requestChange(cookie);
    expect(
      (await openLink(linkToken(emailsTo(OLD_ADDRESS)[0].html))).status,
    ).toBe(200);

    await expectChangeEmailToNewAddress();
    expect(await currentAddress()).toBe(OLD_ADDRESS);
  });

  it("applies the change when the new address confirms", async () => {
    const { cookie } = await seed(true);

    await requestChange(cookie);
    await openLink(linkToken(emailsTo(OLD_ADDRESS)[0].html));
    const verification = await expectChangeEmailToNewAddress();

    expect((await openLink(verification)).status).toBe(200);
    expect(await currentAddress()).toBe(NEW_ADDRESS);

    const record = await fx.prisma.user.findUnique({
      where: { id: "user-owner" },
    });
    expect(record?.emailVerified).toBe(true);
  });

  it("reports the flow as unfulfilled until the new address confirms", async () => {
    const { cookie } = await seed(true);

    await requestChange(cookie);
    await openLink(linkToken(emailsTo(OLD_ADDRESS)[0].html));
    const verification = await expectChangeEmailToNewAddress();

    expect(await isFulfilled(verification)).toBe(false);

    await openLink(verification);

    expect(await isFulfilled(verification)).toBe(true);
  });

  it("stops at the current address when the approval is never given", async () => {
    const { cookie } = await seed(true);

    await requestChange(cookie);

    expect(emailsTo(NEW_ADDRESS)).toHaveLength(0);
    expect(await currentAddress()).toBe(OLD_ADDRESS);
  });
});

describe("changing the address of an unverified account", () => {
  it("goes straight to the new address, since there is nothing to approve", async () => {
    const { cookie } = await seed(false);

    await requestChange(cookie);

    // No approval email: better-auth only asks the current address when it is
    // verified, and this one is not.
    expect(emailsTo(OLD_ADDRESS)).toHaveLength(0);
    await expectChangeEmailToNewAddress();
  });

  it("still sends a change-email template, not the sign-up one", async () => {
    const { cookie } = await seed(false);

    await requestChange(cookie);

    // The bug this suite exists for: this branch is where an unverified account
    // lands, and it used to answer with "thank you for creating an account".
    expect(emailsTo(NEW_ADDRESS).map((mail) => mail.subject)).not.toContain(
      "Verify your email address",
    );
  });

  it("applies the change when the new address confirms", async () => {
    const { cookie } = await seed(false);

    await requestChange(cookie);
    const verification = await expectChangeEmailToNewAddress();

    expect((await openLink(verification)).status).toBe(200);
    expect(await currentAddress()).toBe(NEW_ADDRESS);
  });

  it("leaves the address untouched until the link is opened", async () => {
    const { cookie } = await seed(false);

    await requestChange(cookie);

    expect(await currentAddress()).toBe(OLD_ADDRESS);
  });
});
