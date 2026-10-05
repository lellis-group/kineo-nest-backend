import { Prisma } from "../generated/prisma/client";
import {
  PLATFORM_REASONS_INCLUDING_LEGACY,
  PLATFORM_REJECTION_REASONS,
} from "./rejection-reasons";

/**
 * The three things a rejected application can be, for the applicant reading it.
 *
 * A `REJECTED` status alone says nothing they can act on. The same status covers a
 * practice refusing this person, another candidate being retained for a posting
 * they were shortlisted for, and the posting leaving circulation underneath them —
 * and those need three different reactions, one of which is "nothing was wrong with
 * you".
 *
 * They are read off `rejectionReason` rather than off `decisionSource`, because the
 * reasons are already written, already stored, and already a closed set in
 * `rejection-reasons.ts`. Expanding `decisionSource` to name these three would mean
 * six new enum members the code would have to start writing, and a migration, to
 * say something two columns already say.
 *
 * `decisionSource` is still needed for one of them: an erasure settles applications
 * as `REJECTED` with no reason and a `SYSTEM` source, which is neither a refusal nor
 * a posting that ended, and a reason-only test would file it under the first.
 */
export const REJECTION_BUCKETS = {
  /** Another candidate was retained for a posting this applicant was on. */
  PASSED_OVER: "PASSED_OVER",
  /** The posting left circulation: withdrawn, cancelled, or erased. */
  POSTING_ENDED: "POSTING_ENDED",
  /** The practice refused this person, in its own words or none. */
  REFUSED: "REFUSED",
} as const;

export type RejectionBucket =
  (typeof REJECTION_BUCKETS)[keyof typeof REJECTION_BUCKETS];

/**
 * The predicate for one bucket, over any scope.
 *
 * Deliberately three separate predicates rather than one classifier applied
 * in JavaScript: the counts and the page have to be answered by the same rule, and
 * two implementations of a classification are two classifications.
 */
export function rejectionBucketWhere(
  bucket: RejectionBucket,
): Prisma.ApplicationWhereInput {
  switch (bucket) {
    case REJECTION_BUCKETS.PASSED_OVER:
      return {
        status: "REJECTED",
        rejectionReason: PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
      };

    case REJECTION_BUCKETS.POSTING_ENDED:
      return {
        status: "REJECTED",
        rejectionReason: {
          in: [
            PLATFORM_REJECTION_REASONS.listingWithdrawn,
            PLATFORM_REJECTION_REASONS.listingCancelled,
            "The listing has been cancelled",
          ],
        },
      };

    case REJECTION_BUCKETS.REFUSED:
      return {
        status: "REJECTED",
        decisionSource: "PRACTICE_REJECTED",
        // `notIn` excludes NULL — SQL semantics — and a practice may refuse
        // without giving a reason, so the two cases are spelled out. The
        // `decisionSource` above is what keeps an erasure's own settling out.
        OR: [
          { rejectionReason: null },
          { rejectionReason: { notIn: PLATFORM_REASONS_INCLUDING_LEGACY } },
        ],
      };
  }
}

/** Every bucket, for the counts. */
export const REJECTION_BUCKET_KEYS = Object.values(REJECTION_BUCKETS);

/** Zero-filled, so a caller reads 0 rather than undefined for a quiet bucket. */
export function zeroBucketCounts(): Record<RejectionBucket, number> {
  return {
    [REJECTION_BUCKETS.PASSED_OVER]: 0,
    [REJECTION_BUCKETS.POSTING_ENDED]: 0,
    [REJECTION_BUCKETS.REFUSED]: 0,
  };
}
