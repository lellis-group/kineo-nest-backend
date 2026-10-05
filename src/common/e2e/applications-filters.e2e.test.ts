/**
 * The applicant's three situations, against a real database.
 *
 * The classification is turned into SQL and reads two nullable columns, so the
 * things that can go wrong are not typos — they are SQL semantics. `notIn`
 * excludes NULL, which is why the refused bucket spells out "no reason" as its
 * own clause; `in` does not, which is why the older spelling of the cancellation
 * reason has to be named or a cancelled posting counts as a refusal. Neither is
 * visible in the Prisma where-clause object, and a unit test that re-implements
 * the matching would agree with whatever that re-implementation believes.
 *
 * So each row here is inserted and then asked for through the endpoint.
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
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

/** One application per situation, all belonging to the same applicant. */
async function seed() {
  const now = new Date();

  const applicant = await createVerifiedUser(
    fx.prisma,
    "user-applicant",
    "applicant@test.invalid",
    PASSWORD,
  );
  const applicantProfile = await fx.prisma.profile.create({
    data: {
      id: "profile-applicant",
      userId: applicant.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      createdAt: now,
      updatedAt: now,
    },
  });

  const owner = await createVerifiedUser(
    fx.prisma,
    "user-owner",
    "owner@test.invalid",
    PASSWORD,
  );
  const ownerProfile = await fx.prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: owner.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      createdAt: now,
      updatedAt: now,
    },
  });

  await fx.prisma.practice.create({
    data: {
      id: "practice-owner",
      ownerId: ownerProfile.id,
      name: "Cabinet de test",
      address: "1 rue du test",
      city: "Paris",
      createdAt: now,
    },
  });

  const rows: Array<{
    id: string;
    status: string;
    decisionSource: string | null;
    rejectionReason: string | null;
  }> = [
    {
      id: "passed-over",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    },
    {
      id: "withdrawn",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: PLATFORM_REJECTION_REASONS.listingWithdrawn,
    },
    {
      id: "cancelled-now",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: PLATFORM_REJECTION_REASONS.listingCancelled,
    },
    {
      id: "cancelled-legacy",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: "The listing has been cancelled",
    },
    {
      id: "refused-with-reason",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: "We went with someone local",
    },
    {
      id: "refused-without-reason",
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: null,
    },
    {
      id: "settled-by-erasure",
      status: "REJECTED",
      decisionSource: "SYSTEM",
      rejectionReason: null,
    },
    {
      id: "pending",
      status: "PENDING",
      decisionSource: null,
      rejectionReason: null,
    },
  ];

  for (const [index, row] of rows.entries()) {
    const listing = await fx.prisma.replacementListing.create({
      data: {
        id: `listing-${row.id}`,
        practiceId: "practice-owner",
        createdById: ownerProfile.id,
        title: `Listing ${row.id}`,
        startDate: new Date("2026-11-02"),
        endDate: new Date("2026-11-16"),
        specialty: "GENERALIST",
        status: "OPEN",
        urgent: false,
        createdAt: now,
        updatedAt: now,
      },
    });

    await fx.prisma.application.create({
      data: {
        id: row.id,
        listingId: listing.id,
        applicantId: applicantProfile.id,
        status: row.status as never,
        decisionSource: row.decisionSource as never,
        rejectionReason: row.rejectionReason,
        createdAt: new Date(now.getTime() + index),
        updatedAt: new Date(now.getTime() + index),
      },
    });
  }

  const cookies = await signIn(fx.baseUrl, applicant.email, PASSWORD);
  return { cookies, rows };
}

async function mine(cookies: string, query: Record<string, string> = {}) {
  const response = await request(fx.baseUrl)
    .get("/applications/mine")
    .query(query)
    .set("Cookie", cookies);

  expect(response.status).toBe(200);
  return response.body;
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

describe("GET /applications/mine", () => {
  it("puts each situation in its own bucket, and nothing in two", async () => {
    const { cookies, rows } = await seed();

    const buckets: Record<string, string[]> = {
      PASSED_OVER: ["passed-over"],
      POSTING_ENDED: ["withdrawn", "cancelled-now", "cancelled-legacy"],
      REFUSED: ["refused-with-reason", "refused-without-reason"],
    };

    for (const [bucket, expected] of Object.entries(buckets)) {
      const body = await mine(cookies, { bucket });

      // Sorted on both sides: the listing orders by `createdAt` then id, which in
      // this fixture would just be an accident of how the ids were spelled. The
      // classification is the claim under test, not the row order.
      expect([...ids(body)].sort()).toEqual([...expected].sort());
      expect(body.meta.bucketCounts[bucket]).toBe(expected.length);
    }

    // Two rows belong to no bucket: one settled by an erasure, one still pending.
    // Counting them anywhere would tell the applicant their application was
    // refused when nothing of the sort happened.
    const all = await mine(cookies);
    const claimed = Object.values(buckets).flat();
    expect(all.data).toHaveLength(rows.length);
    for (const row of rows.filter((r) => !claimed.includes(r.id))) {
      expect(claimed).not.toContain(row.id);
    }
  });

  it("names the same bucket on a row as the filter uses to select it", async () => {
    // The classification is written once and read twice — once as SQL for the
    // counts and the filter, once as a field for the rows a client groups. This is
    // the test that the two readings cannot drift: a row the `REFUSED` filter
    // returns, and labels `PASSED_OVER`, is a page whose chip and cards disagree.
    const { cookies, rows } = await seed();

    const byFilter: Record<string, string[]> = {};
    for (const bucket of ["PASSED_OVER", "POSTING_ENDED", "REFUSED"]) {
      const body = await mine(cookies, { bucket });
      byFilter[bucket] = ids(body);
      for (const row of body.data) {
        expect(row.rejectionBucket).toBe(bucket);
      }
    }

    // And from the other side: every row carries the bucket its own fields say,
    // with nothing claimed by a filter it does not belong to.
    const all = await mine(cookies);
    const named = Object.values(byFilter).flat();
    for (const row of all.data) {
      if (row.rejectionBucket === null) {
        expect(named).not.toContain(row.id);
      } else {
        expect(byFilter[row.rejectionBucket]).toContain(row.id);
      }
    }

    expect(rows).toHaveLength(8);
  });

  it("counts the buckets over the whole collection, not the filtered page", async () => {
    const { cookies } = await seed();

    // A chip that counted what it had just filtered would always read as the page
    // size, so the counters answer over everything and the page answers over the
    // filter.
    const filtered = await mine(cookies, { bucket: "PASSED_OVER", limit: "1" });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.meta.total).toBe(1);
    expect(filtered.meta.bucketCounts).toMatchObject({
      PASSED_OVER: 1,
      POSTING_ENDED: 3,
      REFUSED: 2,
    });
    expect(filtered.meta.counts.REJECTED).toBe(7);
  });

  it("still counts statuses the way it always did", async () => {
    const { cookies } = await seed();
    const body = await mine(cookies);

    expect(body.meta.counts).toMatchObject({
      total: 8,
      PENDING: 1,
      REJECTED: 7,
      SHORTLISTED: 0,
      ACCEPTED: 0,
      WITHDRAWN: 0,
    });
  });

  it("refuses a bucket it does not know", async () => {
    const { cookies } = await seed();
    const response = await request(fx.baseUrl)
      .get("/applications/mine")
      .query({ bucket: "SOMETHING_ELSE" })
      .set("Cookie", cookies);

    expect(response.status).toBe(400);
  });
});

const ids = (body: { data: { id: string }[] }) =>
  body.data.map((row) => row.id);
