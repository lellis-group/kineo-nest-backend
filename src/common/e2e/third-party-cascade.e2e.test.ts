/**
 * The cascade `Profile -> Practice -> ReplacementListing -> Application` must
 * not destroy an application belonging to another candidate, and the refusal
 * has to arrive over HTTP: the guard sits in the service, and only the wired
 * application proves the ownership check runs before the delete.
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
import { SYSTEM_SCAFFOLD } from "../system-scaffold";
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
  const application = await prisma.application.create({
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

  return {
    owner,
    ownerProfile,
    practice,
    listing,
    candidateProfile,
    application,
  };
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

describe("deleting an account that holds another candidate's application", () => {
  it("refuses DELETE /replacement-listings/:id with 409 and keeps the application", async () => {
    const { owner } = await seedScenario();
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .delete("/replacement-listings/listing-1")
      .set("Cookie", cookies);

    expect(response.status).toBe(409);
    expect(await fx.prisma.replacementListing.count()).toBe(1);
    expect(await fx.prisma.application.count()).toBe(1);
    expect(
      await fx.prisma.application.findUnique({
        where: { id: "application-1" },
      }),
    ).toMatchObject({ message: "I am available." });
  });

  it("refuses DELETE /practices/:id with 409 and keeps the application", async () => {
    const { owner } = await seedScenario();
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .delete("/practices/practice-owner")
      .set("Cookie", cookies);

    expect(response.status).toBe(409);
    // The scaffold is the only other practice, and it is not the owner's.
    expect(
      await fx.prisma.practice.count({
        where: { id: { not: SYSTEM_SCAFFOLD.practiceId } },
      }),
    ).toBe(1);
    expect(await fx.prisma.application.count()).toBe(1);
  });

  it("refuses DELETE /profile/:id with 409 and keeps the application", async () => {
    const { owner, ownerProfile } = await seedScenario();
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .delete(`/profile/${ownerProfile.id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(409);
    expect(
      await fx.prisma.profile.count({
        where: { id: { not: SYSTEM_SCAFFOLD.profileId } },
      }),
    ).toBe(2);
    expect(await fx.prisma.application.count()).toBe(1);
  });

  it("allows the delete once the application is settled, and answers with the listing DTO", async () => {
    const { owner } = await seedScenario();
    await fx.prisma.application.update({
      where: { id: "application-1" },
      data: { status: "REJECTED", rejectionReason: "Sans objet" },
    });
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .delete("/replacement-listings/listing-1")
      .set("Cookie", cookies);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "listing-1",
      title: "General practitioner cover",
      applicationsCount: 0,
    });
    expect(typeof response.body.startDate).toBe("string");
    expect(response.body).not.toHaveProperty("createdById");
    expect(await fx.prisma.replacementListing.count()).toBe(0);
    expect(await fx.prisma.application.count()).toBe(0);
  });

  it("refuses to delete a FILLED listing through an accepted placement", async () => {
    const { owner } = await seedScenario();
    await fx.prisma.application.update({
      where: { id: "application-1" },
      data: { status: "ACCEPTED" },
    });
    await fx.prisma.replacementListing.update({
      where: { id: "listing-1" },
      data: { status: "FILLED" },
    });
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .delete("/replacement-listings/listing-1")
      .set("Cookie", cookies);

    expect(response.status).toBe(400);
    expect(await fx.prisma.application.count()).toBe(1);
  });
});
