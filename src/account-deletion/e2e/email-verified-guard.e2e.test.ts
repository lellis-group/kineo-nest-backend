import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import request from "supertest";
import { bootApp, resetData, shutdownApp } from "./harness";

/**
 * The contract `EmailVerifiedGuard` has to hold: a write is allowed only while
 * the account row says the email is verified, and never once it has been
 * erased. Anonymization sets `emailVerified = false` and `deletedAt`, so both
 * refusals below are the same rule read from the row.
 *
 * Reached through a real request because a guard that never runs proves nothing.
 */

let fx: Awaited<ReturnType<typeof bootApp>>;

const PASSWORD = "correct-horse-battery-staple";
const USER_ID = "guard-user";
const EMAIL = `${USER_ID}@example.test`;

/**
 * One account and one session, established once.
 *
 * Signing in per test would spend the throttler's `short` tier — it counts
 * every sign-in against the caller, not per account — and the suite would fail
 * on a 429 that has nothing to do with the guard. Every case below needs the
 * same thing anyway: a session whose row says the account is verified.
 */
async function signedInSession(): Promise<string[]> {
  const { prisma } = fx;
  const { hashPassword } = await import("better-auth/crypto");

  await prisma.user.create({
    data: { id: "guard-user", email: EMAIL, emailVerified: true },
  });
  await prisma.account.create({
    data: {
      id: "account-guard-user",
      accountId: "guard-user",
      userId: "guard-user",
      providerId: "credential",
      password: await hashPassword(PASSWORD),
    },
  });

  const response = await request(fx.baseUrl)
    .post("/api/auth/sign-in/email")
    .send({ email: EMAIL, password: PASSWORD });

  if (response.status !== 200) {
    throw new Error(
      `sign-in failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  return response.headers["set-cookie"] as unknown as string[];
}

/** Puts the account back to the state a fresh sign-in would see. */
async function restoreVerified() {
  await fx.prisma.user.update({
    where: { id: USER_ID },
    data: { emailVerified: true, deletedAt: null },
  });
}

let cookies: string[];

beforeAll(async () => {
  fx = await bootApp();
  await resetData(fx.prisma);
  cookies = await signedInSession();
});

afterAll(async () => {
  await shutdownApp();
});

describe("EmailVerifiedGuard", () => {
  beforeEach(async () => {
    await restoreVerified();
  });

  it("allows a write when the database row says verified", async () => {
    const response = await request(fx.baseUrl)
      .post("/profile")
      .set("Cookie", cookies)
      .send({ specialty: "GENERALIST", profileType: "BOTH" });

    expect(response.status).toBe(201);
  });

  it("refuses a write when the database row says unverified", async () => {
    await fx.prisma.user.update({
      where: { id: USER_ID },
      data: { emailVerified: false },
    });

    const response = await request(fx.baseUrl)
      .post("/profile")
      .set("Cookie", cookies)
      .send({ specialty: "GENERALIST", profileType: "BOTH" });

    expect(response.status).toBe(403);
  });

  it("refuses a write once the account is erased", async () => {
    // `deletedAt` never reaches the session payload, so this state can only be
    // observed on the row. The guard reads the row, which is what makes the
    // refusal hold rather than depending on `emailVerified` also being false.
    await fx.prisma.user.update({
      where: { id: USER_ID },
      data: { deletedAt: new Date() },
    });

    const response = await request(fx.baseUrl)
      .post("/profile")
      .set("Cookie", cookies)
      .send({ specialty: "GENERALIST", profileType: "BOTH" });
    expect(response.status).toBe(403);
  });

  it("refuses an anonymous write", async () => {
    const response = await request(fx.baseUrl)
      .post("/profile")
      .send({ specialty: "GENERALIST", profileType: "BOTH" });

    expect(response.status).toBe(401);
  });
});
