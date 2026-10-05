import { Prisma } from "../generated/prisma/client";
import {
  LEGACY_LISTING_CANCELLED_REASON,
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

/** How a bucket reads a row's reason: one of these, or anything else. */
type ReasonRule =
  | { kind: "one-of"; reasons: string[] }
  | { kind: "not-platform" };

/**
 * The classification, written once.
 *
 * Both consumers are derived from this table rather than spelled out separately:
 * `rejectionBucketWhere` becomes SQL for the counts and the filtering, and
 * `rejectionBucketOf` names the bucket for a row in a response body. If those were
 * two hand-written implementations they would agree only until someone edited one,
 * and the disagreement would be silent — the counts would say one thing and the rows
 * another, which is the version of this bug a user cannot even report clearly.
 */
type BucketSpec = {
  status: "REJECTED";
  /** Omitted when the bucket is about the source rather than the reason. */
  reason?: ReasonRule;
  decisionSource?: "PRACTICE_REJECTED";
};

const BUCKET_SPECS: Record<RejectionBucket, BucketSpec> = {
  [REJECTION_BUCKETS.PASSED_OVER]: {
    status: "REJECTED",
    reason: {
      kind: "one-of",
      reasons: [PLATFORM_REJECTION_REASONS.anotherCandidateRetained],
    },
  },

  [REJECTION_BUCKETS.POSTING_ENDED]: {
    status: "REJECTED",
    reason: {
      kind: "one-of",
      reasons: [
        PLATFORM_REJECTION_REASONS.listingWithdrawn,
        PLATFORM_REJECTION_REASONS.listingCancelled,
        // Named rather than inferred: the copy was reviewed and this spelling was
        // written before that, so it is still in older databases. Missing it files a
        // cancelled posting as a refusal, the one reading that is always wrong.
        LEGACY_LISTING_CANCELLED_REASON,
      ],
    },
  },

  [REJECTION_BUCKETS.REFUSED]: {
    status: "REJECTED",
    // The load-bearing use of the source. An erasure settles an application the same
    // way a refusal with no reason looks, and only this keeps them apart.
    decisionSource: "PRACTICE_REJECTED",
    reason: { kind: "not-platform" },
  },
};

function matchesReason(rule: ReasonRule, reason: string | null): boolean {
  switch (rule.kind) {
    case "one-of":
      // Spelled without `includes` on a possibly-null value on purpose: a null
      // reason is never one of these.
      return reason !== null && rule.reasons.includes(reason);
    case "not-platform":
      // A refusal needs no reason, so a missing one still counts — which is also
      // why the SQL side has to spell the null case out.
      return (
        reason === null || !PLATFORM_REASONS_INCLUDING_LEGACY.includes(reason)
      );
  }
}

/**
 * The bucket a stored row falls in, or null when it falls in none.
 *
 * Null is the ordinary answer, not an error: a pending application, and a rejection
 * an erasure settled, are both in no bucket.
 */
export function rejectionBucketOf(row: {
  status: string;
  decisionSource: string | null;
  rejectionReason: string | null;
}): RejectionBucket | null {
  for (const [bucket, spec] of Object.entries(BUCKET_SPECS) as Array<
    [RejectionBucket, BucketSpec]
  >) {
    if (row.status !== spec.status) continue;
    if (spec.decisionSource && row.decisionSource !== spec.decisionSource)
      continue;
    if (spec.reason && !matchesReason(spec.reason, row.rejectionReason))
      continue;
    return bucket;
  }
  return null;
}

/** The same rule as SQL, for the filter and for the counts. */
export function rejectionBucketWhere(
  bucket: RejectionBucket,
): Prisma.ApplicationWhereInput {
  const spec = BUCKET_SPECS[bucket];

  const where: Prisma.ApplicationWhereInput = { status: spec.status };
  if (spec.decisionSource) {
    where.decisionSource = spec.decisionSource;
  }

  if (spec.reason?.kind === "one-of") {
    where.rejectionReason = { in: spec.reason.reasons };
  }

  if (spec.reason?.kind === "not-platform") {
    // SQL `notIn` excludes NULL, so "no reason given" has to be its own clause or a
    // practice refusing without writing anything disappears from the counts.
    where.OR = [
      { rejectionReason: null },
      { rejectionReason: { notIn: PLATFORM_REASONS_INCLUDING_LEGACY } },
    ];
  }

  return where;
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
