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

/**
 * Id of the profile the first test creates, captured from its response.
 *
 * The API generates the id, so it cannot be assumed: the `PATCH` and `DELETE`
 * cases below need the real one, and a profile is unique per user, so they
 * cannot create a second to work with. `null` until that first test runs.
 */
let profileId: string | null = null;

beforeAll(async () => {
  fx = await bootApp();
  await resetData(fx.prisma);
  cookies = await signedInSession();
});

afterAll(async () => {
  await shutdownApp();
});

/** The shared fixture the write cases act on. Fails loudly rather than 404ing. */
function existingProfileId(): string {
  if (!profileId) {
    throw new Error(
      "no profile was created: the first test in this suite must run first",
    );
  }
  return profileId;
}

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
    profileId = response.body?.id ?? null;
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

  it("guards PATCH as well, not only POST", async () => {
    // The guard used to sit on the four `POST` handlers only, so every `PATCH`
    // and `DELETE` ran unchecked: an unverified account could accept a
    // candidate, close a posting or delete a practice while being refused on
    // `POST /profile`. Driven over HTTP because the point is which handlers
    // carry the guard, which no service-level test can observe.
    //
    // The profile comes from the first test in this suite, which POSTed one.
    // A profile is unique per user, so it cannot be created again here.
    const id = existingProfileId();

    await fx.prisma.user.update({
      where: { id: USER_ID },
      data: { emailVerified: false },
    });

    const response = await request(fx.baseUrl)
      .patch(`/profile/${id}`)
      .set("Cookie", cookies)
      .send({ city: "Lyon" });

    expect(response.status).toBe(403);

    const unchanged = await fx.prisma.profile.findUnique({
      where: { id },
      select: { city: true },
    });
    expect(unchanged?.city).toBeNull();
  });

  it("guards DELETE as well, not only POST", async () => {
    const id = existingProfileId();

    await fx.prisma.user.update({
      where: { id: USER_ID },
      data: { emailVerified: false },
    });

    const response = await request(fx.baseUrl)
      .delete(`/profile/${id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(403);

    const stillThere = await fx.prisma.profile.findUnique({
      where: { id },
      select: { id: true },
    });
    expect(stillThere).not.toBeNull();
  });

  it("still lets an unverified account read its own data", async () => {
    // The guard has to widen to every write without narrowing the reads: a
    // candidate whose verification is pending must still be able to see the
    // status of their own applications. The test name used to say "verified"
    // while asserting the opposite of what it set up.
    await fx.prisma.user.update({
      where: { id: USER_ID },
      data: { emailVerified: false },
    });

    const response = await request(fx.baseUrl)
      .get("/profile/me")
      .set("Cookie", cookies);

    expect(response.status).toBe(200);
  });
});
