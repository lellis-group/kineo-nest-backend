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

  it("allows DELETE /profile/:id when the active applications are elsewhere", async () => {
    // The negative case of the one above, and the one the guard got wrong: it
    // used to run with no listing filter at all, so any candidate anywhere in
    // the platform applying to anything was enough to refuse this deletion. The
    // refusal tests passed all the same — they assert a 409 that an unscoped
    // query produces even more reliably than a scoped one.
    const { owner, ownerProfile, application } = await seedScenario();
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    // This scenario refuses the delete on purpose, so the refusal is lifted by
    // settling the owner's only third-party application. What is left is the
    // shape the guard used to get wrong: the owner owns nothing at stake, and
    // someone else's application is on someone else's listing.
    await fx.prisma.application.delete({ where: { id: application.id } });

    // Somebody else owns an unrelated listing, with its own applicant.
    const stranger = await createVerifiedUser(
      fx.prisma,
      "user-stranger",
      "stranger@test.invalid",
      PASSWORD,
    );
    const strangerProfile = await fx.prisma.profile.create({
      data: {
        id: "profile-stranger",
        userId: stranger.id,
        specialty: "GENERALIST",
        profileType: "INSTALLED",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const otherListing = await fx.prisma.replacementListing.create({
      data: {
        id: "listing-stranger",
        practiceId: (
          await fx.prisma.practice.create({
            data: {
              id: "practice-stranger",
              ownerId: strangerProfile.id,
              name: "Other Practice",
              address: "2 rue",
              city: "Lyon",
              createdAt: new Date(),
            },
          })
        ).id,
        createdById: strangerProfile.id,
        title: "Another cover",
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
        id: "application-stranger",
        listingId: otherListing.id,
        applicantId: strangerProfile.id,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await request(fx.baseUrl)
      .delete(`/profile/${ownerProfile.id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(200);
    expect(
      await fx.prisma.profile.count({
        where: { id: { not: SYSTEM_SCAFFOLD.profileId } },
      }),
    ).toBe(2);
    // The owner's profile, practice and listing went. The stranger's application
    // survived a cascade that had nothing to do with it, which is the whole
    // point of scoping the guard.
    expect(await fx.prisma.application.count()).toBe(1);
    expect(
      await fx.prisma.application.count({
        where: { id: "application-stranger" },
      }),
    ).toBe(1);
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
