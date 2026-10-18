/**
 * The whole owner-side life of a listing, over HTTP.
 *
 * The unit spec drives the service directly, and the cascade suite probes only
 * the delete guard; nothing walked `POST` through `publish`, `update`, `close`
 * and `cancel` the way a user does, so every route whose serializer had a
 * mismatched schema answered 500 without a single test noticing — which is what
 * happened to the delete route and to every one of these endpoints the day the
 * `practice` field stopped being optional. Only the wired application proves a
 * route answers at all.
 *
 * The database is seeded through Prisma, the routes go through HTTP: the ids are
 * the real ones the API would have to accept (they are cuids, and the create DTO
 * validates that), while the requests prove the wiring.
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

// A quarantine against whatever a developer's `.env` carries: the quota tests
// below count against a cap that has to hold in every environment, so it is set
// here, before the application is imported and its configuration frozen.
process.env.MAX_ACTIVE_LISTINGS_PER_PROFILE = "2";

const PASSWORD = "Password123!";

let fx: E2EFixture;

interface SeededOwner {
  profileId: string;
  practiceId: string;
  email: string;
  cookies: string;
}

interface SeededCandidate {
  profileId: string;
  email: string;
}

/**
 * An owner who holds nothing but the practice the listing hangs on.
 *
 * The listing is created over HTTP (that is the route under test), so this
 * returns the practice id the POST body needs rather than creating the row.
 */
async function seedOwner(): Promise<SeededOwner> {
  const { prisma } = fx;
  const now = new Date();

  const user = await createVerifiedUser(
    prisma,
    `user-owner-${crypto.randomUUID()}`,
    `owner-${crypto.randomUUID()}@test.invalid`,
    PASSWORD,
  );
  const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

  const profile = await prisma.profile.create({
    data: {
      userId: user.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      isPublic: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  const practice = await prisma.practice.create({
    data: {
      ownerId: profile.id,
      name: "Test Practice",
      address: "1 rue",
      city: "Lyon",
      isPublic: true,
      createdAt: now,
    },
  });

  return {
    profileId: profile.id,
    practiceId: practice.id,
    email: user.email,
    cookies,
  };
}

/** A candidate whose profile passes the email-verified gate, ready to sign in. */
async function seedCandidate(tag: string): Promise<SeededCandidate> {
  const { prisma } = fx;
  const now = new Date();

  const user = await createVerifiedUser(
    prisma,
    `user-${tag}-${crypto.randomUUID()}`,
    `${tag}-${crypto.randomUUID()}@test.invalid`,
    PASSWORD,
  );
  const profile = await prisma.profile.create({
    data: {
      userId: user.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      createdAt: now,
      updatedAt: now,
    },
  });

  return { profileId: profile.id, email: user.email };
}

interface CreateListingBody {
  practiceId: string;
  title: string;
  startDate: string;
  endDate: string;
  specialty: string;
  urgent?: boolean;
  description?: string;
  maxApplications?: number;
}

function listingBody(
  practiceId: string,
  overrides: Partial<CreateListingBody> = {},
): CreateListingBody {
  return {
    title: "General practitioner cover",
    startDate: "2026-11-02T00:00:00.000Z",
    endDate: "2026-11-16T00:00:00.000Z",
    specialty: "GENERALIST",
    ...overrides,
    practiceId,
  };
}

async function createListing(
  cookies: string,
  practiceId: string,
  overrides: Partial<CreateListingBody> = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await request(fx.baseUrl)
    .post("/replacement-listings")
    .set("Cookie", cookies)
    .send(listingBody(practiceId, overrides));
  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
  };
}

/** A listing read straight from Prisma, without id bookkeeping in the tests. */
async function seedListingRow(
  ownerId: string,
  practiceId: string,
  overrides: Partial<{
    status:
      | "DRAFT"
      | "OPEN"
      | "IN_DISCUSSION"
      | "FILLED"
      | "CLOSED"
      | "CANCELLED";
    maxApplications: number;
  }> = {},
): Promise<ReplacementListing> {
  const { prisma } = fx;
  const now = new Date();

  return prisma.replacementListing.create({
    data: {
      practiceId,
      createdById: ownerId,
      title: "Seeded cover",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: overrides.status ?? "OPEN",
      urgent: false,
      maxApplications: overrides.maxApplications,
      createdAt: now,
      updatedAt: now,
    },
  });
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

describe("the owner-side lifecycle of a listing", () => {
  it("creates a draft, publishes it open, and reads it back through the browse routes", async () => {
    const owner = await seedOwner();

    // Create: the answer is the DTO the write records serialize with, the shape
    // that once answered 500 because the schema required a relation a write
    // cannot include.
    const created = await createListing(owner.cookies, owner.practiceId, {
      maxApplications: 5,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "General practitioner cover",
      status: "DRAFT",
      applicationsCount: 0,
      specialty: "GENERALIST",
    });
    expect(typeof created.body.startDate).toBe("string");
    expect(created.body).not.toHaveProperty("createdById");
    const id: string = created.body.id as string;

    // A draft is invisible to the anonymous feed.
    const feedBefore = await request(fx.baseUrl).get("/replacement-listings");
    expect(feedBefore.status).toBe(200);
    expect(feedBefore.body.data).toHaveLength(0);

    // ...but visible in its owner's own list, in the draft bucket.
    const mineBefore = await request(fx.baseUrl)
      .get("/replacement-listings/mine")
      .set("Cookie", owner.cookies);
    expect(mineBefore.status).toBe(200);
    expect(mineBefore.body.meta.total).toBe(1);
    expect(mineBefore.body.meta.counts.DRAFT).toBe(1);

    // Publish: now the feed carries it, JSON-shaped for the wire.
    const published = await request(fx.baseUrl)
      .patch(`/replacement-listings/${id}/publish`)
      .set("Cookie", owner.cookies);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id, status: "OPEN" });
    expect(typeof published.body.startDate).toBe("string");

    const feed = await request(fx.baseUrl).get("/replacement-listings");
    expect(feed.status).toBe(200);
    expect(feed.body.data).toMatchObject([{ id, status: "OPEN" }]);

    const facets = await request(fx.baseUrl).get(
      "/replacement-listings/facets",
    );
    expect(facets.status).toBe(200);
    expect(facets.body).toMatchObject({ total: 1, urgent: 0 });
    expect(facets.body.bySpecialty.GENERALIST).toBe(1);

    // The practice was seeded without coordinates: the population counts one
    // posting, but nothing it can draw.
    const places = await request(fx.baseUrl).get(
      "/replacement-listings/places",
    );
    expect(places.status).toBe(200);
    expect(places.body).toMatchObject({
      places: [],
      unlocated: 1,
      totalPlaces: 0,
      truncated: false,
    });

    const pageOf = await request(fx.baseUrl)
      .get("/replacement-listings/page-of")
      .query({ id, sort: "startDate", limit: 10 });
    expect(pageOf.status).toBe(200);
    expect(pageOf.body).toEqual({ page: 1 });
  });

  it("refuses to publish a listing that is not a draft", async () => {
    const owner = await seedOwner();
    const { status, body } = await createListing(
      owner.cookies,
      owner.practiceId,
    );
    expect(status).toBe(201);

    const response = await request(fx.baseUrl)
      .patch(`/replacement-listings/${body.id}/publish`)
      .set("Cookie", owner.cookies);
    expect(response.status).toBe(200);

    const again = await request(fx.baseUrl)
      .patch(`/replacement-listings/${body.id}/publish`)
      .set("Cookie", owner.cookies);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.listingNotDraft);
  });

  it("refuses to create a listing for someone else's practice", async () => {
    const owner = await seedOwner();
    const candidate = await seedCandidate("candidate");

    const response = await request(fx.baseUrl)
      .post("/replacement-listings")
      .set("Cookie", await signIn(fx.baseUrl, candidate.email, PASSWORD))
      .send(listingBody(owner.practiceId));
    expect(response.status).toBe(403);
  });

  it("refuses a quota-breaching third listing", async () => {
    const owner = await seedOwner();

    expect((await createListing(owner.cookies, owner.practiceId)).status).toBe(
      201,
    );
    expect((await createListing(owner.cookies, owner.practiceId)).status).toBe(
      201,
    );
    const third = await createListing(owner.cookies, owner.practiceId);
    expect(third.status).toBe(400);
    expect(third.body.code).toBe(REFUSAL_CODES.listingQuotaReached);
  });

  it("updates content and refuses an inverted date pair", async () => {
    const owner = await seedOwner();
    const listing = await seedListingRow(owner.profileId, owner.practiceId);
    const cookies = await signIn(fx.baseUrl, owner.email, PASSWORD);

    // The schema-level rule: both dates present and inverted.
    const schemaRefusal = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies)
      .send({
        startDate: "2026-12-01T00:00:00.000Z",
        endDate: "2026-11-01T00:00:00.000Z",
      });
    expect(schemaRefusal.status).toBe(400);

    // The service-level rule: one date alone, set after the stored other one.
    const serviceRefusal = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies)
      .send({ startDate: "2026-12-01T00:00:00.000Z" });
    expect(serviceRefusal.status).toBe(400);
    expect(serviceRefusal.body.code).toBe(REFUSAL_CODES.listingInvalidDates);

    // The ordinary update.
    const response = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies)
      .send({ title: "Renamed cover" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: listing.id,
      title: "Renamed cover",
    });
    expect(typeof response.body.updatedAt).toBe("string");
  });

  it("closes an open listing, rejects its candidates with the platform's words, and refuses to close it again", async () => {
    const owner = await seedOwner();
    const candidate = await seedCandidate("candidate");
    const listing = await seedListingRow(owner.profileId, owner.practiceId);
    await fx.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: candidate.profileId,
        status: "PENDING",
        message: "I am available.",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const closed = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}/close`)
      .set("Cookie", await signIn(fx.baseUrl, owner.email, PASSWORD));
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      id: listing.id,
      status: "CLOSED_NO_CANDIDATE",
    });
    expect(typeof closed.body.startDate).toBe("string");

    // The candidate was told the posting went away, by the platform itself.
    const application = await fx.prisma.application.findFirst({
      where: { listingId: listing.id },
    });
    expect(application?.status).toBe("REJECTED");
    expect(application?.decisionSource).toBe("PRACTICE_REJECTED");
    expect(application?.rejectionReason).toBe(
      PLATFORM_REJECTION_REASONS.listingWithdrawn,
    );

    const again = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}/close`)
      .set("Cookie", await signIn(fx.baseUrl, owner.email, PASSWORD));
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.listingNotCloseable);
  });

  it("cancels an open listing, tells its candidates the posting was abandoned, and refuses a second cancel", async () => {
    const owner = await seedOwner();
    const candidate = await seedCandidate("candidate");
    const listing = await seedListingRow(owner.profileId, owner.practiceId);
    await fx.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: candidate.profileId,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const cancelled = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}/cancel`)
      .set("Cookie", await signIn(fx.baseUrl, owner.email, PASSWORD));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      id: listing.id,
      status: "CANCELLED",
    });

    const application = await fx.prisma.application.findFirst({
      where: { listingId: listing.id },
    });
    expect(application?.rejectionReason).toBe(
      PLATFORM_REJECTION_REASONS.listingCancelled,
    );

    const again = await request(fx.baseUrl)
      .patch(`/replacement-listings/${listing.id}/cancel`)
      .set("Cookie", await signIn(fx.baseUrl, owner.email, PASSWORD));
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(REFUSAL_CODES.listingAlreadyClosed);
  });

  it("deletes a draft: the serializer owns the answer to the route that once 500'd", async () => {
    const owner = await seedOwner();
    const listing = await seedListingRow(owner.profileId, owner.practiceId, {
      status: "DRAFT",
    });

    const response = await request(fx.baseUrl)
      .delete(`/replacement-listings/${listing.id}`)
      .set("Cookie", await signIn(fx.baseUrl, owner.email, PASSWORD));
    expect(response.status).toBe(200);
    // The answer is the listing DTO: wire-shaped dates, a count a write must
    // derive, `createdById` withheld, no practice — a delete left nothing to
    // read one from.
    expect(response.body).toMatchObject({
      id: listing.id,
      title: "Seeded cover",
      status: "DRAFT",
      applicationsCount: 0,
    });
    expect(typeof response.body.startDate).toBe("string");
    expect(response.body).not.toHaveProperty("createdById");
    expect(response.body).not.toHaveProperty("practice");
    expect(
      await fx.prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(0);
  });
});
