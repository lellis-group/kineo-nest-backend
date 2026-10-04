/**
 * The guard has to run on every write over HTTP, not only on POST.
 *
 * The unit spec drives the guard directly with a fake; only this one can show
 * that it is actually attached to the routes, that the session is resolved before
 * it runs, and that the decision reads the user row rather than the session
 * payload.
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

/**
 * Signs in first, then optionally un-verifies the row.
 *
 * better-auth refuses to sign an unverified account in at all, so the session has
 * to exist before the row changes. That is the situation the guard has to cope
 * with anyway: the cookie says verified, the row says otherwise.
 */
async function signInOwner(options: { thenUnverify?: boolean } = {}) {
  const { prisma } = fx;
  const now = new Date();

  const user = await createVerifiedUser(
    prisma,
    "user-owner",
    "owner@test.invalid",
    PASSWORD,
  );
  const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

  if (options.thenUnverify) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: false },
    });
  }

  const profile = await prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: user.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.practice.create({
    data: {
      id: "practice-owner",
      ownerId: profile.id,
      name: "Test Practice",
      address: "1 rue",
      city: "Lyon",
      createdAt: now,
    },
  });
  const listing = await prisma.replacementListing.create({
    data: {
      id: "listing-1",
      practiceId: "practice-owner",
      createdById: profile.id,
      title: "Cover",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: "OPEN",
      urgent: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  return { user, profile, listing, cookies };
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

describe("an unverified account", () => {
  it("may read", async () => {
    const { cookies } = await signInOwner({ thenUnverify: true });

    const response = await request(fx.baseUrl)
      .get("/replacement-listings/listing-1")
      .set("Cookie", cookies);

    expect(response.status).toBe(200);
  });

  it("may not PATCH: the guard used to sit on POST handlers only", async () => {
    const { cookies } = await signInOwner({ thenUnverify: true });

    const response = await request(fx.baseUrl)
      .patch("/replacement-listings/listing-1")
      .set("Cookie", cookies)
      .send({ description: "changed" });

    expect(response.status).toBe(403);
    expect(
      (
        await fx.prisma.replacementListing.findUnique({
          where: { id: "listing-1" },
        })
      )?.description,
    ).toBeNull();
  });

  it("may not DELETE", async () => {
    const { cookies } = await signInOwner({ thenUnverify: true });

    const response = await request(fx.baseUrl)
      .delete("/replacement-listings/listing-1")
      .set("Cookie", cookies);

    expect(response.status).toBe(403);
    expect(await fx.prisma.replacementListing.count()).toBe(1);
  });

  it("may not POST", async () => {
    const { cookies } = await signInOwner({ thenUnverify: true });

    const response = await request(fx.baseUrl)
      .post("/practices")
      .set("Cookie", cookies)
      .send({ name: "Practice", address: "2 rue", city: "Lyon" });

    expect(response.status).toBe(403);
  });
});

describe("a verified account", () => {
  it("may write", async () => {
    const { cookies } = await signInOwner();

    const response = await request(fx.baseUrl)
      .patch("/replacement-listings/listing-1")
      .set("Cookie", cookies)
      .send({ description: "changed" });

    expect(response.status).toBe(200);
  });

  it("stops writing as soon as the row is anonymized, whatever the session says", async () => {
    const { cookies, user } = await signInOwner();

    // The account erasure anonymizes the row and clears emailVerified. The
    // session cookie still carries `emailVerified: true`, and better-auth may
    // serve it from its cookie cache.
    await fx.prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });

    const response = await request(fx.baseUrl)
      .patch("/replacement-listings/listing-1")
      .set("Cookie", cookies)
      .send({ description: "changed" });

    expect(response.status).toBe(403);
  });
});
