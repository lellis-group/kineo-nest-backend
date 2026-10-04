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
  anotherCandidateRetained: "Un autre candidat a été retenu pour cette annonce",
  listingCancelled: "L'annonce a été annulée",
  listingWithdrawn: "L'annonce n'est plus en ligne",
  applicantAccountErased:
    "Le compte du candidat a été supprimé, la candidature a été retirée",
} as const;

export type PlatformRejectionReason =
  (typeof PLATFORM_REJECTION_REASONS)[keyof typeof PLATFORM_REJECTION_REASONS];

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
const LEGACY_LISTING_CANCELLED_REASON = "The listing has been cancelled";

export function isPlatformRejectionReason(reason: string): boolean {
  return (
    PLATFORM_REJECTION_REASON_VALUES.includes(reason) ||
    reason === LEGACY_LISTING_CANCELLED_REASON
  );
}
