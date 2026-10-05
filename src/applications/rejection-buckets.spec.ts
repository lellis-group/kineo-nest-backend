import { describe, expect, it } from "bun:test";
import {
  REJECTION_BUCKET_KEYS,
  type RejectionBucket,
  rejectionBucketOf,
  rejectionBucketWhere,
  zeroBucketCounts,
} from "./rejection-buckets";
import {
  PLATFORM_REASONS_INCLUDING_LEGACY,
  PLATFORM_REJECTION_REASONS,
} from "./rejection-reasons";

/**
 * What each predicate reads, asserted directly.
 *
 * There is a matching test for this in `applications-filters.e2e.test.ts`, and
 * that is the one that proves the classification: it inserts a row per situation
 * and asks the database. This file deliberately does not re-implement the matching
 * to fake that coverage — a helper that decides "does this row match" in
 * TypeScript agrees with a wrong predicate exactly when it was written from the
 * same mistake, and the SQL details that matter here (`notIn` excluding NULL, `in`
 * not) are invisible to it anyway.
 *
 * So what is left is the part a where-clause object can be checked for honestly:
 * that each predicate names the situations it is supposed to, spelled with the
 * reason constants rather than copies of them.
 */

const of = (bucket: RejectionBucket) => rejectionBucketWhere(bucket);

describe("rejection bucket predicates", () => {
  it("keys the retained-candidate bucket on the one reason that means it", () => {
    const where = of("PASSED_OVER");

    expect(where.status).toBe("REJECTED");
    expect((where.rejectionReason as { in: string[] }).in).toEqual([
      PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    ]);
  });

  it("covers both spellings of a cancellation in the ended-posting bucket", () => {
    const where = of("POSTING_ENDED");
    const in_ = (where.rejectionReason as { in: string[] }).in;

    expect(where.status).toBe("REJECTED");
    expect([...in_].sort()).toEqual(
      [
        PLATFORM_REJECTION_REASONS.listingWithdrawn,
        PLATFORM_REJECTION_REASONS.listingCancelled,
        "The listing has been cancelled",
      ].sort(),
    );
  });

  it("names the reason the erasure wrote as neither a refusal nor an ended posting", () => {
    // If this reason were in either list, an erased account's withdrawal would be
    // reported to the applicant as a decision about them.
    expect(of("POSTING_ENDED")).not.toMatchObject({
      rejectionReason: {
        in: [PLATFORM_REJECTION_REASONS.applicantAccountErased],
      },
    });
    expect(of("REFUSED")).not.toMatchObject({
      OR: [{ rejectionReason: { notIn: expect.anything() } }],
    });
  });

  it("reads the practice source in the refused bucket, so an erasure is excluded", () => {
    // This is the one place `decisionSource` is load-bearing: an erasure settles an
    // application as REJECTED with no reason, which a reason-only test would file
    // under "refused by the practice".
    expect(of("REFUSED").decisionSource).toBe("PRACTICE_REJECTED");
  });

  it("treats a refusal without a reason as a refusal", () => {
    const where = of("REFUSED");

    // SQL `notIn` excludes NULL, so "no reason given" has to be its own clause or
    // a practice refusing without writing anything disappears.
    const clauses = (where as { OR: unknown[] }).OR;
    expect(clauses).toContainEqual({ rejectionReason: null });
    expect(clauses).toContainEqual({
      rejectionReason: { notIn: PLATFORM_REASONS_INCLUDING_LEGACY },
    });
  });

  it("excludes every platform reason from a refusal, including the old spelling", () => {
    const where = of("REFUSED");
    const notIn = (
      (where as { OR: Array<{ rejectionReason: unknown }> }).OR.find(
        (clause) => clause.rejectionReason !== null,
      ) as { rejectionReason: { notIn: string[] } }
    ).rejectionReason.notIn;

    expect([...notIn].sort()).toEqual(
      [...PLATFORM_REASONS_INCLUDING_LEGACY].sort(),
    );
    expect(notIn).toContain("The listing has been cancelled");
    expect(notIn).toContain(
      PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    );
  });

  it("keeps the buckets to the three the applicant can be told apart", () => {
    expect([...REJECTION_BUCKET_KEYS].sort()).toEqual([
      "PASSED_OVER",
      "POSTING_ENDED",
      "REFUSED",
    ]);
  });

  it("zero-fills the counts so a quiet bucket reads 0 and not undefined", () => {
    // A chip rendering `undefined` shows as a blank, which reads as "no data yet"
    // rather than "none happened".
    expect(zeroBucketCounts()).toEqual({
      PASSED_OVER: 0,
      POSTING_ENDED: 0,
      REFUSED: 0,
    });
  });
});

describe("rejectionBucketOf", () => {
  /**
   * The function the response body is built from, pinned on the row shapes the
   * application can actually hold.
   *
   * The expectation is written out rather than recomputed: a table built from the
   * function's own output and compared against it proves only that the function is
   * deterministic. Unlike a helper that re-decides "does this row match", this
   * calls the shipped classifier, so a wrong answer here is a wrong answer there.
   */
  const row = (
    status: string,
    decisionSource: string | null,
    rejectionReason: string | null,
  ) => ({ status, decisionSource, rejectionReason });

  const PRACTICE = "PRACTICE_REJECTED";

  const cases: Array<[string, RejectionBucket | null]> = [
    ["another candidate was retained", "PASSED_OVER"],
    ["the listing was withdrawn", "POSTING_ENDED"],
    ["the listing was cancelled, current spelling", "POSTING_ENDED"],
    ["the listing was cancelled, older spelling", "POSTING_ENDED"],
    ["the practice refused in its own words", "REFUSED"],
    ["the practice refused without a reason", "REFUSED"],
    // The regression the whole module exists to prevent: an erasure settles a
    // rejection with no reason, which is what a refusal with no reason also looks
    // like. Filed as a refusal, it tells someone a practice turned them down.
    ["an erasure settled it with no reason", null],
    ["the account was erased and the application withdrawn", null],
    ["a withdrawn application", null],
    ["a pending application", null],
  ];

  const rowsFor: Record<string, ReturnType<typeof row>> = {
    "another candidate was retained": row(
      "REJECTED",
      PRACTICE,
      PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    ),
    "the listing was withdrawn": row(
      "REJECTED",
      PRACTICE,
      PLATFORM_REJECTION_REASONS.listingWithdrawn,
    ),
    "the listing was cancelled, current spelling": row(
      "REJECTED",
      PRACTICE,
      PLATFORM_REJECTION_REASONS.listingCancelled,
    ),
    "the listing was cancelled, older spelling": row(
      "REJECTED",
      PRACTICE,
      "The listing has been cancelled",
    ),
    "the practice refused in its own words": row(
      "REJECTED",
      PRACTICE,
      "We went with someone local",
    ),
    "the practice refused without a reason": row("REJECTED", PRACTICE, null),
    "an erasure settled it with no reason": row("REJECTED", "SYSTEM", null),
    "the account was erased and the application withdrawn": row(
      "REJECTED",
      "SYSTEM",
      PLATFORM_REJECTION_REASONS.applicantAccountErased,
    ),
    "a withdrawn application": row("WITHDRAWN", null, null),
    "a pending application": row("PENDING", null, null),
  };

  for (const [label, expected] of cases) {
    it(`classifies ${label} as ${expected ?? "no bucket"}`, () => {
      expect(rejectionBucketOf(rowsFor[label])).toBe(expected);
    });
  }

  it("covers every row shape the table names", () => {
    // A case with no fixture would silently assert on undefined and pass, which is
    // how a row shape ends up untested without anyone noticing.
    expect(Object.keys(rowsFor).sort()).toEqual(
      cases.map(([label]) => label).sort(),
    );
  });
});
