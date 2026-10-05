import { describe, expect, it } from "bun:test";
import {
  REJECTION_BUCKET_KEYS,
  type RejectionBucket,
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
    expect(where.rejectionReason).toBe(
      PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
    );
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
