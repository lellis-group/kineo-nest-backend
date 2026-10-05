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

type BucketCounts = {
  PASSED_OVER: number;
  POSTING_ENDED: number;
  REFUSED: number;
};

type MineBody = {
  data: Array<{
    id: string;
    status: string;
    rejectionBucket: "PASSED_OVER" | "POSTING_ENDED" | "REFUSED" | null;
  }>;
  meta: {
    total: number;
    counts: Record<string, number>;
    bucketCounts: BucketCounts;
  };
};

async function mine(
  cookies: string,
  query: Record<string, string> = {},
): Promise<MineBody> {
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
  it("counts each situation over the whole collection", async () => {
    const { cookies, rows } = await seed();
    const body = await mine(cookies);

    expect(body.data).toHaveLength(rows.length);
    expect(body.meta.bucketCounts).toEqual({
      PASSED_OVER: 1,
      POSTING_ENDED: 3,
      REFUSED: 2,
    });
  });

  it("agrees with itself: the totals are the rows' own buckets", async () => {
    // The classification is written once and read twice — once as SQL for these
    // totals, once as a field for the rows a client groups and labels. This is the
    // test that the two readings cannot drift: a total that counted the erasure's
    // settled rejection as a refusal, while every row called it nothing, is a chip
    // that contradicts its own cards and that nobody can report clearly.
    const { cookies } = await seed();
    const body = await mine(cookies);

    const fromRows: BucketCounts = {
      PASSED_OVER: 0,
      POSTING_ENDED: 0,
      REFUSED: 0,
    };
    for (const row of body.data) {
      // `?? null`: an older backend omits the field, and reading undefined as a
      // bucket would be a claim about a row nobody classified.
      if (row.rejectionBucket !== null && row.rejectionBucket !== undefined) {
        fromRows[row.rejectionBucket] += 1;
      }
    }

    expect(body.meta.bucketCounts).toEqual(fromRows);
  });

  it("leaves a settled-by-erasure rejection in no bucket and out of the totals", async () => {
    const { cookies } = await seed();
    const body = await mine(cookies);

    const settled = body.data.find((row) => row.id === "settled-by-erasure");
    expect(settled?.status).toBe("REJECTED");
    expect(settled?.rejectionBucket).toBeNull();

    // One pending plus one settled: the rejected total is larger than the sum of
    // the three buckets, which is the honest shape and the reason the chips cannot
    // be built by adding up the statuses.
    expect(body.meta.counts.REJECTED).toBe(7);
    const summed =
      body.meta.bucketCounts.PASSED_OVER +
      body.meta.bucketCounts.POSTING_ENDED +
      body.meta.bucketCounts.REFUSED;
    expect(summed).toBe(6);
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

  it("keeps the status filter working alongside the buckets", async () => {
    const { cookies } = await seed();

    const pending = await mine(cookies, { status: "PENDING" });
    expect(pending.data.map((row: { id: string }) => row.id)).toEqual([
      "pending",
    ]);
    expect(pending.meta.bucketCounts.PASSED_OVER).toBe(1);
  });
});
