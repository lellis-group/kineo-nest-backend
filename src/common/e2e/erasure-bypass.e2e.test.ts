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
import { ERASURE_ERROR_CODES } from "../../account-deletion/erasure-codes";
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
      name: "Test Practice",
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
      title: "General practitioner cover",
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
      message: "I am available.",
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
  tokenOptions: { expiresAt?: Date } = {},
) {
  const pepper = process.env.DELETION_PEPPER ?? "";
  await fx.prisma.dataDeletionRequest.create({
    data: {
      userIdHash: deletionHash(userId, pepper),
      emailHash: deletionHash(email, pepper),
    },
  });
  return seedDeleteToken(token, userId, tokenOptions);
}

/** The verification row better-auth mints for the emailed confirmation link. */
function seedDeleteToken(
  token: string,
  userId: string,
  { expiresAt }: { expiresAt?: Date } = {},
) {
  return fx.prisma.verification.create({
    data: {
      id: `verification-delete-${token}`,
      identifier: `delete-account-${token}`,
      value: userId,
      expiresAt: expiresAt ?? new Date(Date.now() + 3_600_000),
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
  ).toMatchObject({ message: "I am available." });
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

  it("supersedes the previous request instead of failing on it", async () => {
    // A partial unique index allows one `PENDING` row per fingerprint, so a
    // second request used to fail its insert, leave the *first* row pending, and
    // email a link that would execute that earlier request — whose `createdAt`
    // could be weeks old. A request nobody made any more stayed confirmable,
    // because the trail had no way to say it had been replaced.
    const { owner } = await seedScenario();
    const cookies = await signIn(owner.email);

    await request(fx.baseUrl)
      .post("/api/auth/delete-user")
      .set("Cookie", cookies)
      .send({ password: PASSWORD });

    const second = await request(fx.baseUrl)
      .post("/api/auth/delete-user")
      .set("Cookie", cookies)
      .send({ password: PASSWORD });

    expect(second.status).toBe(200);

    const rows = await fx.prisma.dataDeletionRequest.findMany({
      orderBy: { createdAt: "asc" },
      select: { status: true },
    });
    expect(rows).toHaveLength(2);
    // Exactly one is actionable, and it is the newest.
    expect(rows.map((row) => row.status)).toEqual(["SUPERSEDED", "PENDING"]);
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

    // The practice the erased account owned, read back two ways: the row, and
    // the public endpoint that used to list it with its real name and address for
    // the whole grace window.
    const practice = await fx.prisma.practice.findUnique({
      where: { id: "practice-owner" },
    });
    expect(practice).toMatchObject({
      isPublic: false,
      latitude: null,
      longitude: null,
    });
    expect(practice?.name).not.toBe("Test Practice");

    const listed = await request(fx.baseUrl).get("/practices");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("Test Practice");
    // And out of the geographic index, since it has no coordinates left.
    const geo = await request(fx.baseUrl).get(
      "/practices?lat=45.75&lng=4.85&radiusKm=50",
    );
    expect(geo.status).toBe(200);
    expect(JSON.stringify(geo.body)).not.toContain("Test Practice");

    // The application survives, on a listing owned by the scaffold.
    const application = await fx.prisma.application.findUnique({
      where: { id: "application-1" },
      include: { listing: true },
    });
    expect(application?.message).toBe("I am available.");
    expect(application?.listing.createdById).toBe(SYSTEM_SCAFFOLD.profileId);

    // The trail is keyed, not plaintext.
    const trail = await fx.prisma.dataDeletionRequest.findFirst({
      orderBy: { createdAt: "desc" },
    });
    expect(trail?.status).toBe("ANONYMIZED");
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

  it("goes through when the same candidate applied to two of the owner's listings", async () => {
    // The case one shared ghost listing could not survive. `application` carries
    // `@@unique([listingId, applicantId])`, so moving both of this candidate's
    // rows onto one ghost makes them the same pair: the write is rejected with
    // P2002, the whole erasure transaction rolls back, and this link never works
    // again. Applying to two postings of the same practice is ordinary, not rare.
    const { owner, ownerProfile, practice } = await seedScenario();
    const candidateProfile = await fx.prisma.profile.findUnique({
      where: { id: "profile-candidate" },
    });
    if (!candidateProfile) {
      throw new Error("seedScenario did not create the candidate's profile");
    }

    const second = await fx.prisma.replacementListing.create({
      data: {
        id: "listing-2",
        practiceId: practice.id,
        createdById: ownerProfile.id,
        title: "Second cover",
        startDate: new Date("2026-12-01"),
        endDate: new Date("2026-12-15"),
        specialty: "GENERALIST",
        status: "OPEN",
        urgent: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await fx.prisma.application.create({
      data: {
        id: "application-2",
        listingId: second.id,
        applicantId: candidateProfile.id,
        status: "SHORTLISTED",
        message: "Still available.",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await seedErasureRequest("erasure-two", owner.id, owner.email);
    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-two" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ detachedApplications: 2 });

    // One ghost per original listing, so the pairs stay distinct.
    const parked = await fx.prisma.application.findMany({
      where: { id: { in: ["application-1", "application-2"] } },
      select: { id: true, listingId: true },
    });
    expect(parked.map((row) => row.listingId).sort()).toEqual([
      "ghost-for-listing-1",
      "ghost-for-listing-2",
    ]);
  });

  it("rejects an unknown token with 404 and changes nothing", async () => {
    await seedScenario();

    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "never-issued" });

    expect(response.status).toBe(404);
    await expectNothingDestroyed();
  });

  /**
   * The code, on the wire.
   *
   * The frontend picks between two screens here — request again, or nothing left
   * to do — on a `code`, and both of those answers arrive as 404 or 410. Reading
   * the status alone cannot tell them apart, which is the whole reason these
   * codes exist. Asserted over HTTP because a code that never leaves the process
   * is the same as no code at all.
   *
   * What this does *not* cover: the harness pins `NODE_ENV=test`, so the filter
   * takes its development branch here, which passes the exception body through
   * untouched. That this suite would still pass with the code dropped from the
   * hardened branch is exactly why `http-exception.filter.spec.ts` pins it
   * separately — between the two, both branches are covered.
   */
  it("names the failure in a code, so the client is not left guessing", async () => {
    const { owner } = await seedScenario();

    // Never issued.
    const unknown = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "never-issued" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({
      code: ERASURE_ERROR_CODES.NO_PENDING_REQUEST,
    });

    // One request, then links against it — a partial unique index allows a single
    // PENDING row per fingerprint, so a second request cannot even be recorded.
    // That is a separate defect; this test only needs one trail row to act on.
    await seedErasureRequest("erasure-expired", owner.id, owner.email, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-expired" });
    expect(expired.status).toBe(410);
    expect(expired.body).toMatchObject({
      code: ERASURE_ERROR_CODES.TOKEN_EXPIRED,
    });

    // The same request, a link that has not expired.
    await seedDeleteToken("erasure-ok", owner.id);
    const ok = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-ok" });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toHaveProperty("code");

    // And then a link for an account that is already gone: the same 410 as the
    // expired one, the opposite instruction to the reader.
    await seedDeleteToken("erasure-replay", owner.id);
    const replay = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "erasure-replay" });
    expect(replay.status).toBe(410);
    expect(replay.body).toMatchObject({
      code: ERASURE_ERROR_CODES.ALREADY_ERASED,
    });
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
