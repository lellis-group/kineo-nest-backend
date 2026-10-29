/**
 * Every decision on an application, over HTTP.
 *
 * `applications-filters` covers the reads and `third-party-cascade` covers the
 * delete guard; nothing drove the write routes that change an application's
 * status itself — `shortlist`, `accept`, `reject`, `withdraw` and the message
 * update — so their refusals, their ownership rules and the listing statuses
 * they derive were enforced everywhere but proven nowhere. The wired
 * application is what can prove a 400 is the *right* refusal and not the
 * accident of an unwired serializer.
 *
 * Same discipline as the other suites: rows are seeded through Prisma, the
 * decisions travel through HTTP, and the assertions read both the HTTP layer
 * and the persisted end state. Fixed ids are safe because every test starts
 * from an empty database (`resetData`), like the cascade suite does.
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
import { PLATFORM_REJECTION_REASONS } from "../../applications/rejection-reasons";
import {
  bootApp,
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
  signIn,
} from "../../common/e2e/harness";
import { REFUSAL_CODES } from "../../common/refusal";
import type { ReplacementListing } from "../../generated/prisma/client";

// The quota test counts against a cap that has to hold in every environment,
// the developer's `.env` included: set before the app is imported and its
// configuration frozen.
process.env.MAX_ACTIVE_APPLICATIONS_PER_PROFILE = "2";

const PASSWORD = "Password123!";

let fx: E2EFixture;

interface Seeded {
  listing: ReplacementListing;
  practiceId: string;
  ownerProfileId: string;
  ownerCookies: string;
  candidateAProfileId: string;
  candidateAEmail: string;
  candidateBProfileId: string;
  candidateBEmail: string;
}

async function seedListing(
  world: { ownerProfileId: string; practiceId: string },
  overrides: Partial<{
    status: "DRAFT" | "OPEN";
    maxApplications: number;
  }> = {},
): Promise<ReplacementListing> {
  return fx.prisma.replacementListing.create({
    data: {
      practiceId: world.practiceId,
      createdById: world.ownerProfileId,
      title: "Cover",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: overrides.status ?? "OPEN",
      urgent: false,
      maxApplications: overrides.maxApplications,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

async function seedWorld(
  options: { maxApplications?: number; status?: "DRAFT" | "OPEN" } = {},
): Promise<Seeded> {
  const { prisma } = fx;
  const now = new Date();

  const owner = await createVerifiedUser(
    prisma,
    "user-owner",
    "owner@world.test",
    PASSWORD,
  );
  const ownerProfile = await prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: owner.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      isPublic: true,
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
      isPublic: true,
      createdAt: now,
    },
  });
  const listing = await seedListing(
    { ownerProfileId: ownerProfile.id, practiceId: practice.id },
    options,
  );

  const candidateA = await createVerifiedUser(
    prisma,
    "user-a",
    "a@world.test",
    PASSWORD,
  );
  const candidateProfileA = await prisma.profile.create({
    data: {
      id: "profile-a",
      userId: candidateA.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      city: "Lyon",
      verified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const candidateB = await createVerifiedUser(
    prisma,
    "user-b",
    "b@world.test",
    PASSWORD,
  );
  const candidateProfileB = await prisma.profile.create({
    data: {
      id: "profile-b",
      userId: candidateB.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      createdAt: now,
      updatedAt: now,
    },
  });

  return {
    listing,
    practiceId: practice.id,
    ownerProfileId: ownerProfile.id,
    ownerCookies: await signIn(fx.baseUrl, owner.email, PASSWORD),
    candidateAProfileId: candidateProfileA.id,
    candidateAEmail: candidateA.email,
    candidateBProfileId: candidateProfileB.id,
    candidateBEmail: candidateB.email,
  };
}

function applyAsCandidate(
  email: string,
  listingId: string,
  body: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return signIn(fx.baseUrl, email, PASSWORD).then((cookies) =>
    request(fx.baseUrl)
      .post("/applications")
      .set("Cookie", cookies)
      .send({ listingId, ...body })
      .then((response) => ({
        status: response.status,
        body: response.body as Record<string, unknown>,
      })),
  );
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

describe("submitting an application", () => {
  it("moves the listing to IN_DISCUSSION and answers with the application DTO", async () => {
    const world = await seedWorld();

    const { status, body } = await applyAsCandidate(
      world.candidateAEmail,
      world.listing.id,
      { message: "I am available." },
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      status: "PENDING",
      message: "I am available.",
      rejectionBucket: null,
    });
    expect(typeof body.createdAt).toBe("string");
    // The create answer is the flat row: no embedded listing and no applicant
    // card. The detail read below is the one that embeds both.
    expect(body).not.toHaveProperty("listing");
    expect(body).not.toHaveProperty("applicant");

    const persisted = await fx.prisma.application.findFirstOrThrow({
      where: { listingId: world.listing.id },
    });
    expect(persisted.decisionSource).toBeNull();

    // The detail read is the one that embeds the listing, snapshot-shaped.
    const detail = await request(fx.baseUrl)
      .get(`/applications/${persisted.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD));
    expect(detail.status).toBe(200);
    expect(detail.body.listing).toMatchObject({
      id: world.listing.id,
      status: "IN_DISCUSSION",
      practice: {
        id: world.practiceId,
        name: "Test Practice",
      },
    });

    const after = await fx.prisma.replacementListing.findUniqueOrThrow({
      where: { id: world.listing.id },
    });
    expect(after.status).toBe("IN_DISCUSSION");
  });

  it("answers 409 with a stable code when the candidate applies twice", async () => {
    const world = await seedWorld();
    expect(
      (await applyAsCandidate(world.candidateAEmail, world.listing.id)).status,
    ).toBe(201);

    const second = await applyAsCandidate(
      world.candidateAEmail,
      world.listing.id,
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(REFUSAL_CODES.applicationAlreadyExists);
  });

  it("refuses an INSTALLED profile", async () => {
    const world = await seedWorld();

    const response = await request(fx.baseUrl)
      .post("/applications")
      .set("Cookie", world.ownerCookies)
      .send({ listingId: world.listing.id });
    expect(response.status).toBe(403);
  });

  it("refuses a draft listing", async () => {
    const world = await seedWorld({ status: "DRAFT" });

    const { status, body } = await applyAsCandidate(
      world.candidateAEmail,
      world.listing.id,
    );
    expect(status).toBe(400);
    expect(body.code).toBe(REFUSAL_CODES.applicationListingNotAccepting);
  });

  it("refuses an application once the cap is already reached", async () => {
    const world = await seedWorld({ maxApplications: 1 });
    // The row keeps the OPEN it was seeded with: the derive that would call it
    // FULL is a write applications trigger, and this test pins the limit check
    // itself rather than the status check that masks it.
    await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateBProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const { status, body } = await applyAsCandidate(
      world.candidateAEmail,
      world.listing.id,
    );
    expect(status).toBe(400);
    expect(body.code).toBe(REFUSAL_CODES.applicationListingLimitReached);
  });

  it("refuses a third active application from the same candidate", async () => {
    const world = await seedWorld();
    // Two more postings for the same owner: what fills is the *candidate's*
    // quota, not the listing's.
    const second = await seedListing(world);
    const third = await seedListing(world);

    expect(
      (await applyAsCandidate(world.candidateAEmail, world.listing.id)).status,
    ).toBe(201);
    expect(
      (await applyAsCandidate(world.candidateAEmail, second.id)).status,
    ).toBe(201);

    const refused = await applyAsCandidate(world.candidateAEmail, third.id);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(REFUSAL_CODES.applicationQuotaReached);
  });
});

describe("reading an application", () => {
  it("answers to its applicant and the listing's owner, 404s a stranger", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asApplicant = await request(fx.baseUrl)
      .get(`/applications/${application.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD));
    expect(asApplicant.status).toBe(200);
    expect(asApplicant.body).toMatchObject({ id: application.id });

    const asOwner = await request(fx.baseUrl)
      .get(`/applications/${application.id}`)
      .set("Cookie", world.ownerCookies);
    expect(asOwner.status).toBe(200);

    const asStranger = await request(fx.baseUrl)
      .get(`/applications/${application.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateBEmail, PASSWORD));
    expect(asStranger.status).toBe(404);
  });

  it("answers the received list to the listing's owner only", async () => {
    const world = await seedWorld();
    await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asOwner = await request(fx.baseUrl)
      .get(`/applications/listing/${world.listing.id}`)
      .set("Cookie", world.ownerCookies);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.data).toHaveLength(1);
    // A list row carries the applicant card, not the listing: the owner is
    // reading applications *for* a listing they already know.
    expect(asOwner.body.data[0]).toMatchObject({ status: "PENDING" });
    expect(asOwner.body.data[0]).not.toHaveProperty("listing");
    expect(asOwner.body.data[0].applicant).toMatchObject({
      id: world.candidateAProfileId,
    });
    expect(asOwner.body.meta.counts.total).toBe(1);

    const asStranger = await request(fx.baseUrl)
      .get(`/applications/listing/${world.listing.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateBEmail, PASSWORD));
    expect(asStranger.status).toBe(403);

    const unknown = await request(fx.baseUrl)
      .get("/applications/listing/does-not-exist")
      .set("Cookie", world.ownerCookies);
    expect(unknown.status).toBe(404);
  });
});

describe("the owner's tools", () => {
  it("marks viewed only for the owner, and does not move an earlier stamp", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asCandidate = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/view`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD));
    expect(asCandidate.status).toBe(403);

    const asOwner = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/view`)
      .set("Cookie", world.ownerCookies);
    expect(asOwner.status).toBe(200);
    const viewedAt: string = asOwner.body.viewedAt;
    expect(viewedAt).not.toBeNull();

    // The service returns the stored row when one is already stamped, so the
    // second visit answers the first stamp rather than its own.
    const again = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/view`)
      .set("Cookie", world.ownerCookies);
    expect(again.status).toBe(200);
    expect(again.body.viewedAt).toBe(viewedAt);
  });

  it("shortlists a pending application once, by the owner only", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asCandidate = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/shortlist`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD));
    expect(asCandidate.status).toBe(403);

    const asOwner = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/shortlist`)
      .set("Cookie", world.ownerCookies);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toMatchObject({ status: "SHORTLISTED" });
    expect(asOwner.body.respondedAt).not.toBeNull();

    const again = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/shortlist`)
      .set("Cookie", world.ownerCookies);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.applicationNotShortlistable);
  });
});

describe("editing an application", () => {
  it("lets the applicant change the message while pending, and no one else", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        message: "I am available.",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asOwner = await request(fx.baseUrl)
      .patch(`/applications/${application.id}`)
      .set("Cookie", world.ownerCookies)
      .send({ message: "owner edit" });
    expect(asOwner.status).toBe(403);

    const asCandidate = await request(fx.baseUrl)
      .patch(`/applications/${application.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD))
      .send({ message: "Now available evenings." });
    expect(asCandidate.status).toBe(200);
    expect(asCandidate.body.message).toBe("Now available evenings.");

    await fx.prisma.application.update({
      where: { id: application.id },
      data: { status: "SHORTLISTED" },
    });
    const settled = await request(fx.baseUrl)
      .patch(`/applications/${application.id}`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD))
      .send({ message: "too late" });
    expect(settled.status).toBe(400);
    expect(settled.body.code).toBe(REFUSAL_CODES.applicationNotPending);
  });
});

describe("rejecting an application", () => {
  it("records the refusal and its bucket, then refuses to refuse again", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "SHORTLISTED",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const asCandidate = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/reject`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD))
      .send({ rejectionReason: "pas de motivation" });
    expect(asCandidate.status).toBe(403);

    const asOwner = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/reject`)
      .set("Cookie", world.ownerCookies)
      .send({ rejectionReason: "Profil ne coïncide pas" });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toMatchObject({
      status: "REJECTED",
      rejectionReason: "Profil ne coïncide pas",
      rejectionBucket: "REFUSED",
    });
    // The source column is not part of the published schema, so the wire strips
    // it: the decision's *author* is proven in the row, not in the response.
    const rejectedRow = await fx.prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(rejectedRow.decisionSource).toBe("PRACTICE_REJECTED");

    const again = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/reject`)
      .set("Cookie", world.ownerCookies)
      .send({ rejectionReason: "encore" });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.applicationNotRejectable);
  });

  it("reopens the listing once no active application is left", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await fx.prisma.replacementListing.update({
      where: { id: world.listing.id },
      data: { status: "IN_DISCUSSION" },
    });

    const rejected = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/reject`)
      .set("Cookie", world.ownerCookies)
      .send({ rejectionReason: "Disponibilités non compatibles" });
    expect(rejected.status).toBe(200);

    const listing = await fx.prisma.replacementListing.findUniqueOrThrow({
      where: { id: world.listing.id },
    });
    expect(listing.status).toBe("OPEN");
  });
});

describe("accepting an application", () => {
  it("fills the listing, rejects the other candidates itself, and refuses a re-accept", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "SHORTLISTED",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const otherApplication = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateBProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const accepted = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/accept`)
      .set("Cookie", world.ownerCookies);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "ACCEPTED" });
    expect(accepted.body.respondedAt).not.toBeNull();
    const acceptedRow = await fx.prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(acceptedRow.decisionSource).toBe("PRACTICE_ACCEPTED");

    const listing = await fx.prisma.replacementListing.findUniqueOrThrow({
      where: { id: world.listing.id },
    });
    expect(listing.status).toBe("FILLED");

    const other = await fx.prisma.application.findUniqueOrThrow({
      where: { id: otherApplication.id },
    });
    expect(other.status).toBe("REJECTED");
    expect(other.decisionSource).toBe("PRACTICE_REJECTED");
    expect(other.rejectionReason).toBe(
      PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    );

    const again = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/accept`)
      .set("Cookie", world.ownerCookies);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.applicationNotAcceptable);
  });

  it("refuses to accept onto a listing that has left circulation", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await fx.prisma.replacementListing.update({
      where: { id: world.listing.id },
      data: { status: "CANCELLED" },
    });

    const response = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/accept`)
      .set("Cookie", world.ownerCookies);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(
      REFUSAL_CODES.applicationListingNotAccepting,
    );
  });
});

describe("the same owner's two tabs racing", () => {
  /**
   * The race this suite's other tests cannot stage: both decisions are
   * authorized, both are issued at once, and the ordering that comes back is
   * not ours to choose. What has to hold either way is the invariant the
   * inherited unconditional write used to break — an application settled
   * ACCEPTED by the serializable accept must never afterwards read
   * SHORTLISTED, because a shortlist committed after an accept would drag the
   * row back across a decision its then-rejected siblings stayed rejected on
   * and its listing stays FILLED because of.
   */
  it("never repaints an accepted application shortlisted", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Fired together, on the same owner's cookies: whichever one commits
    // first, the other has to yield rather than overwrite.
    const [shortlist, accept] = await Promise.all([
      request(fx.baseUrl)
        .patch(`/applications/${application.id}/shortlist`)
        .set("Cookie", world.ownerCookies)
        .then((response) => response.status),
      request(fx.baseUrl)
        .patch(`/applications/${application.id}/accept`)
        .set("Cookie", world.ownerCookies)
        .then((response) => ({
          status: response.status,
          body: response.body as Record<string, unknown>,
        })),
    ]);

    // The accept wins in both orders the storage can produce: last against a
    // shortlisted row, first against a still-pending one.
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: "ACCEPTED" });
    // The shortlist either went first (and committed) or lost its race (and
    // was refused) — both defensible; what is not is a 409-style downgrade
    // error nobody writes, so only one of the two answers may arrive.
    expect([200, 400]).toContain(shortlist);

    const settled = await fx.prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(settled.status).toBe("ACCEPTED");
    expect(settled.decisionSource).toBe("PRACTICE_ACCEPTED");

    const listing = await fx.prisma.replacementListing.findUniqueOrThrow({
      where: { id: world.listing.id },
    });
    expect(listing.status).toBe("FILLED");
  });
});

describe("withdrawing an application", () => {
  it("only the applicant withdraws, only an active one, and the listing reopens", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listing.id,
        applicantId: world.candidateAProfileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await fx.prisma.replacementListing.update({
      where: { id: world.listing.id },
      data: { status: "IN_DISCUSSION" },
    });

    const asOwner = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/withdraw`)
      .set("Cookie", world.ownerCookies)
      .send({ withdrawnReason: "nope" });
    expect(asOwner.status).toBe(403);

    const asCandidate = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/withdraw`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD))
      .send({ withdrawnReason: "J'ai pris un autre poste" });
    expect(asCandidate.status).toBe(200);
    expect(asCandidate.body).toMatchObject({
      status: "WITHDRAWN",
      withdrawnReason: "J'ai pris un autre poste",
    });
    const withdrawnRow = await fx.prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(withdrawnRow.decisionSource).toBe("CANDIDATE_WITHDREW");

    const listing = await fx.prisma.replacementListing.findUniqueOrThrow({
      where: { id: world.listing.id },
    });
    expect(listing.status).toBe("OPEN");

    const again = await request(fx.baseUrl)
      .patch(`/applications/${application.id}/withdraw`)
      .set("Cookie", await signIn(fx.baseUrl, world.candidateAEmail, PASSWORD))
      .send({ withdrawnReason: "déjà retiré" });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.applicationNotWithdrawable);
  });
});
