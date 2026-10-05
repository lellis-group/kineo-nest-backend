/**
 * The reasons the platform writes itself, and the ones it accepts from a
 * practice.
 *
 * A rejection is told to the applicant, so the reason is product copy rather
 * than a developer string: a practice that types its own reason is fine, but the
 * automatic ones have to read as the platform speaking. That is also why they
 * live here as a closed set — `cancel` and the future auto-rejection write them
 * without going through a DTO, and two copies of the same sentence is how a
 * candidate ends up told two different things for one event.
 */

export const PLATFORM_REJECTION_REASONS = {
  anotherCandidateRetained: "Another candidate was selected for this listing",
  listingCancelled: "This listing was cancelled",
  listingWithdrawn: "This listing is no longer online",
  applicantAccountErased:
    "The candidate's account was erased, so the application was withdrawn",
} as const;

export const PLATFORM_REJECTION_REASON_VALUES: string[] = Object.values(
  PLATFORM_REJECTION_REASONS,
);

/**
 * The older spelling of the cancellation reason.
 *
 * It was written before the copy was reviewed and is still in the databases
 * seeded before this branch, so it stays accepted and mapped rather than
 * replaced: a stored reason is not something the application gets to rewrite.
 */
export const LEGACY_LISTING_CANCELLED_REASON = "The listing has been cancelled";

/**
 * Every string the platform writes itself, the older spelling included.
 *
 * The buckets below have to recognise a platform decision wherever it is spelled,
 * or a listing cancelled before the copy was reviewed would be counted as a
 * refusal by the practice — which is the one reading that is always wrong.
 */
export const PLATFORM_REASONS_INCLUDING_LEGACY: string[] = [
  ...PLATFORM_REJECTION_REASON_VALUES,
  LEGACY_LISTING_CANCELLED_REASON,
];

export function isPlatformRejectionReason(reason: string): boolean {
  return (
    PLATFORM_REJECTION_REASON_VALUES.includes(reason) ||
    reason === LEGACY_LISTING_CANCELLED_REASON
  );
}
