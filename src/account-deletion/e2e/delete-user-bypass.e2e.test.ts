/**
 * better-auth's `delete-user` surface must not be able to erase an account.
 *
 * Its handler reaches `internalAdapter.deleteUser` — a raw cascade through
 * Profile, Practice, ReplacementListing and Application — from two routes that
 * never consult `sendDeleteAccountVerification`: `POST /delete-user` with a
 * `token` body field, and `GET /delete-user/callback?token=`. Both consume the
 * verification row the config mints, so the emailed confirmation link reaches
 * the hard delete directly. `deleteUser.beforeDelete` refuses them; this suite
 * is what keeps it that way.
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
import { deletionHash } from "../../lib/hash";
import { bootApp, type E2EFixture, resetData, shutdownApp } from "./harness";

let fx: E2EFixture;

const PASSWORD = "Password123!";

/** An owner with an open listing three candidates applied to. */
async function seedScenario() {
  const { prisma } = fx;
  const now = new Date();

  const owner = await prisma.user.create({
    data: {
      id: "user-owner",
      email: "owner@test.invalid",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
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
      title: "Remplacement généraliste",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: "OPEN",
      urgent: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  for (const id of ["a", "b", "c"]) {
    const user = await prisma.user.create({
      data: {
        id: `user-cand-${id}`,
        email: `cand-${id}@test.invalid`,
        createdAt: now,
        updatedAt: now,
      },
    });
    const profile = await prisma.profile.create({
      data: {
        id: `profile-cand-${id}`,
        userId: user.id,
        specialty: "GENERALIST",
        profileType: "REPLACEMENT",
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.application.create({
      data: {
        id: `app-${id}`,
        listingId: listing.id,
        applicantId: profile.id,
        status: id === "a" ? "ACCEPTED" : "PENDING",
        message: "Je suis disponible.",
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  return { owner, ownerProfile, practice, listing };
}

async function signIn(email: string) {
  const { hashPassword } = await import("better-auth/crypto");
  await fx.prisma.account.upsert({
    where: { id: "account-owner" },
    create: {
      id: "account-owner",
      // better-auth matches the credential provider on `accountId === userId`.
      accountId: "user-owner",
      userId: "user-owner",
      providerId: "credential",
      password: await hashPassword(PASSWORD),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: {},
  });

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

/** The verification row better-auth mints for the emailed confirmation link. */
function seedDeleteToken(token: string, userId: string) {
  return fx.prisma.verification.create({
    data: {
      id: "verification-delete",
      identifier: `delete-account-${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

/** Everything a hard delete would have taken with it. */
async function expectNothingDestroyed(ownerId: string) {
  expect(await fx.prisma.user.count({ where: { id: ownerId } })).toBe(1);
  expect(
    await fx.prisma.replacementListing.count({ where: { id: "listing-1" } }),
  ).toBe(1);
  expect(await fx.prisma.application.count()).toBe(3);
  expect(
    await fx.prisma.application.count({
      where: { applicantId: { not: "profile-owner" }, message: { not: null } },
    }),
  ).toBe(3);
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
  it("without a token reaches the request phase and deletes nothing", async () => {
    // The safe branch: `sendDeleteAccountVerification` returns before the
    // delete hook. What proves it is the trail row and the token the request
    // phase writes — reaching the delete instead would leave both absent.
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
    expect(
      await fx.prisma.verification.count({
        where: { identifier: { startsWith: "delete-account-" } },
      }),
    ).toBe(1);
    await expectNothingDestroyed(owner.id);
  });

  it("with a token is refused instead of hard-deleting", async () => {
    // The bypass. The token is all the proof of identity better-auth asks for
    // on this branch, and a session cookie is not even required.
    const { owner } = await seedScenario();
    const cookies = await signIn(owner.email);
    await seedDeleteToken("token0000000000000000", owner.id);

    const response = await request(fx.baseUrl)
      .post("/api/auth/delete-user")
      .set("Cookie", cookies)
      .send({ token: "token0000000000000000" });

    expect(response.status).toBe(400);
    expect(response.body?.code).toBe("DELETION_ROUTE_DISABLED");
    await expectNothingDestroyed(owner.id);
  });
});

describe("GET /api/auth/delete-user/callback", () => {
  it("is refused instead of hard-deleting", async () => {
    // The same token, consumed through the callback better-auth puts in the
    // emailed URL. `beforeDelete` runs after the token is consumed, so this
    // burns the token as well — which is why the erasure link goes to
    // `POST /account/confirm-deletion` and not here.
    const { owner } = await seedScenario();
    const cookies = await signIn(owner.email);
    await seedDeleteToken("token1111111111111111", owner.id);

    const response = await request(fx.baseUrl)
      .get("/api/auth/delete-user/callback")
      .query({ token: "token1111111111111111" })
      .set("Cookie", cookies);

    expect(response.status).toBe(400);
    expect(response.body?.code).toBe("DELETION_ROUTE_DISABLED");
    await expectNothingDestroyed(owner.id);
  });
});

describe("POST /account/confirm-deletion", () => {
  it("is still the only route that erases", async () => {
    // The counterweight to the two refusals above: refusing better-auth would
    // be worthless if the replacement did not work.
    const { owner } = await seedScenario();
    const pepper = process.env.DELETION_PEPPER ?? "e".repeat(64);
    await seedDeleteToken("token2222222222222222", owner.id);
    await fx.prisma.dataDeletionRequest.create({
      data: {
        id: "ddr-1",
        userIdHash: deletionHash(owner.id, pepper),
        emailHash: deletionHash(owner.email, pepper),
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "token2222222222222222" });

    expect(response.status).toBe(200);

    // Anonymized, not dropped: the row survives the grace period so the
    // session is revoked and the trail can still be flipped.
    const user = await fx.prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(user.deletedAt).not.toBeNull();
    expect(user.email).not.toBe(owner.email);
    expect(
      await fx.prisma.dataDeletionRequest
        .findUniqueOrThrow({
          where: { id: "ddr-1" },
        })
        .then((row) => row.status),
    ).toBe("ANONYMIZED");
    // The listing leaves circulation rather than being destroyed, and the
    // candidates' rows are detached onto ghost listings rather than cascaded.
    expect(
      await fx.prisma.replacementListing
        .findUniqueOrThrow({
          where: { id: "listing-1" },
        })
        .then((row) => row.status),
    ).toBe("CANCELLED");
    expect(await fx.prisma.application.count()).toBe(3);
  });
});
