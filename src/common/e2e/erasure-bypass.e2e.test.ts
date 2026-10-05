/**
 * better-auth's own `delete-user` surface must not be able to erase an account.
 *
 * Its handler reaches `internalAdapter.deleteUser` — a raw cascade through
 * Profile, Practice, ReplacementListing and Application — from two routes that
 * never consult `sendDeleteAccountVerification`: `POST /delete-user` with a
 * `token` body field, and `GET /delete-user/callback?token=`. Both consume the
 * verification row the config mints, so the emailed confirmation link reaches
 * the hard delete directly. `deleteUser.beforeDelete` refuses them; this suite is
 * what keeps it that way.
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
import { SYSTEM_SCAFFOLD } from "../../common/system-scaffold";
import { deletionHash } from "../../lib/hash";
import {
  bootApp,
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

/** An owner with an open listing a candidate has applied to. */
async function seedScenario() {
  const { prisma } = fx;
  const now = new Date();

  const owner = await createVerifiedUser(
    prisma,
    "user-owner",
    "owner@test.invalid",
    PASSWORD,
  );
  const ownerProfile = await prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: owner.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      createdAt: now,
      updatedAt: now,
    },
  });
  const practice = await prisma.practice.create({
    data: {
      id: "practice-owner",
      ownerId: ownerProfile.id,
      name: "Cabinet Test",
      address: "1 rue",
      city: "Lyon",
      createdAt: now,
    },
  });
  const listing = await prisma.replacementListing.create({
    data: {
      id: "listing-1",
      practiceId: practice.id,
      createdById: ownerProfile.id,
      title: "Remplacement generaliste",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: "OPEN",
      urgent: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  const candidate = await createVerifiedUser(
    prisma,
    "user-candidate",
    "candidate@test.invalid",
    PASSWORD,
  );
  const candidateProfile = await prisma.profile.create({
    data: {
      id: "profile-candidate",
      userId: candidate.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.application.create({
    data: {
      id: "application-1",
      listingId: listing.id,
      applicantId: candidateProfile.id,
      status: "PENDING",
      message: "Je suis disponible.",
      createdAt: now,
      updatedAt: now,
    },
  });

  return { owner, ownerProfile, practice, listing };
}

/**
 * The PENDING trail row and the verification token, as the request phase leaves
 * them: the erasure marks the trail executed rather than writing it.
 */
async function seedErasureRequest(
  token: string,
  userId: string,
  email: string,
) {
  const pepper = process.env.DELETION_PEPPER ?? "";
  await fx.prisma.dataDeletionRequest.create({
    data: {
      userIdHash: deletionHash(userId, pepper),
      emailHash: deletionHash(email, pepper),
    },
  });
  return seedDeleteToken(token, userId);
}

/** The verification row better-auth mints for the emailed confirmation link. */
function seedDeleteToken(token: string, userId: string) {
  return fx.prisma.verification.create({
    data: {
      id: `verification-delete-${token}`,
      identifier: `delete-account-${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function expectNothingDestroyed() {
  expect(await fx.prisma.user.count({ where: { id: "user-owner" } })).toBe(1);
  expect(
    await fx.prisma.user.findUnique({ where: { id: "user-owner" } }),
  ).toMatchObject({
    deletedAt: null,
  });
  expect(await fx.prisma.replacementListing.count()).toBe(1);
  expect(await fx.prisma.application.count()).toBe(1);
  expect(
    await fx.prisma.application.findUnique({ where: { id: "application-1" } }),
  ).toMatchObject({ message: "Je suis disponible." });
}

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
});

describe("POST /api/auth/delete-user", () => {
  it("records the request and emails a link without deleting anything", async () => {
    const { owner } = await seedScenario();
    const cookies = await signIn(owner.email);

    const response = await request(fx.baseUrl)
      .post("/api/auth/delete-user")
      .set("Cookie", cookies)
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    expect(
      await fx.prisma.dataDeletionRequest.count({
        where: { status: "PENDING" },
      }),
    ).toBe(1);
    await expectNothingDestroyed();
  });

  it("refuses a request that carries the confirmation token", async () => {
    const { owner } = await seedScenario();
    const cookies = await signIn(owner.email);
    await seedDeleteToken("bypass-1", owner.id);

    const response = await request(fx.baseUrl)
      .post("/api/auth/delete-user")
      .set("Cookie", cookies)
      .send({ password: PASSWORD, token: "bypass-1" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expectNothingDestroyed();
  });
});

describe("GET /api/auth/delete-user/callback", () => {
  it("refuses the token in the query string", async () => {
    const { owner } = await seedScenario();
    await seedDeleteToken("bypass-2", owner.id);

    const response = await request(fx.baseUrl).get(
      "/api/auth/delete-user/callback?token=bypass-2",
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expectNothingDestroyed();
  });
});

describe("POST /account/confirm-deletion", () => {
  it("anonymizes the account and parks the third-party application", async () => {
    const { owner } = await seedScenario();
    await seedErasureRequest("erasure-1", owner.id, owner.email);

    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-1" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      anonymizedListings: 1,
      detachedApplications: 1,
    });

    const anonymized = await fx.prisma.user.findUnique({
      where: { id: owner.id },
    });
    expect(anonymized?.deletedAt).toBeInstanceOf(Date);
    expect(anonymized?.email).toMatch(/@deleted\.invalid$/);

    // The application survives, on a listing owned by the scaffold.
    const application = await fx.prisma.application.findUnique({
      where: { id: "application-1" },
      include: { listing: true },
    });
    expect(application?.message).toBe("Je suis disponible.");
    expect(application?.listing.createdById).toBe(SYSTEM_SCAFFOLD.profileId);

    // The trail is keyed, not plaintext.
    const trail = await fx.prisma.dataDeletionRequest.findFirst({
      orderBy: { createdAt: "desc" },
    });
    expect(trail?.status).toBe("EXECUTED");
    expect(trail?.userIdHash).toBe(
      deletionHash(owner.id, process.env.DELETION_PEPPER ?? ""),
    );
  });

  it("consumes the token: a second confirmation is refused", async () => {
    const { owner } = await seedScenario();
    await seedErasureRequest("erasure-2", owner.id, owner.email);

    const first = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-2" });
    expect(first.status).toBe(200);

    const second = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-2" });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects an unknown token with 404 and changes nothing", async () => {
    await seedScenario();

    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "never-issued" });

    expect(response.status).toBe(404);
    await expectNothingDestroyed();
  });
});

async function signIn(email: string) {
  const response = await request(fx.baseUrl)
    .post("/api/auth/sign-in/email")
    .send({ email, password: PASSWORD });

  if (response.status !== 200) {
    throw new Error(
      `sign-in failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.headers["set-cookie"] as string;
}
