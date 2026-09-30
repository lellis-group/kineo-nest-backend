/**
 * Application rejection reasons written BY the platform.
 *
 * These are not internal diagnostics: they are stored on the application row
 * and read verbatim by the applicant on their own status banner. Anything
 * written here reaches a French-speaking candidate as-is, so a string authored
 * in English shows up as English in the product.
 *
 * A free-text reason typed by a practice in `reject` is passed through
 * untouched — that is the author's own words, not ours to rewrite.
 *
 * Changing an existing constant does not migrate rows already written with the
 * previous value. Rows carrying the old English literals stay as they are; the
 * frontend maps both spellings, so historical applications keep reading
 * correctly in French.
 */

/** Written when `accept` fills a listing and turns the others down. */
export const REASON_ANOTHER_CANDIDATE_SELECTED =
  "Un autre candidat a été retenu pour cette annonce";

/** Written when the owner closes a listing that still holds applications. */
export const REASON_LISTING_CLOSED = "L'annonce a été clôturée";

/**
 * Written when the owner closes a listing that was still recruiting, so nobody
 * was ever retained.
 *
 * `close` used to be reachable only from `OPEN` (no application at all) or
 * `FILLED` (one retained), which meant `REASON_LISTING_CLOSED` could never
 * mislead anyone. It is reachable from `IN_DISCUSSION` and `FULL` too now, and
 * there it means the opposite of what a retained candidate would read: the
 * posting ended without a replacement. Saying only "clôturée" would leave a
 * shortlisted candidate unable to tell "they found someone" from "nobody was
 * taken", so the distinction is spelled out in the sentence.
 */
export const REASON_LISTING_CLOSED_NO_CANDIDATE =
  "L'annonce a été clôturée, aucun remplaçant n'ayant été retenu";

/** Written when the owner cancels a listing that still holds applications. */
export const REASON_LISTING_CANCELLED = "L'annonce a été annulée";

/**
 * Written on the accepted application when the candidate is erased before the
 * replacement happens. Their data is gone, so the practice is told the
 * candidate is no longer available rather than anything about the erasure.
 */
export const REASON_CANDIDATE_UNAVAILABLE = "Ce candidat n'est plus disponible";

/**
 * Written on the third-party applications moved aside when their listing's
 * owner erases their account. The posting is withdrawn, so whatever the
 * candidate was waiting for will never happen, and leaving the row `PENDING`
 * or `ACCEPTED` would keep telling them a decision is still to come.
 *
 * Wording matters more here than elsewhere: the candidate is the one reading
 * it, the practice they applied to is gone, and nothing about the erasure may
 * be disclosed. `REASON_LISTING_CANCELLED` would be the wrong string — nobody
 * cancelled anything, and reusing it would make an erasure indistinguishable
 * from an owner changing their mind.
 */
export const REASON_LISTING_ERASED =
  "L'annonce n'existe plus, le cabinet a fermé son compte";

/**
 * Reasons that can actually be found on an application row the erasure
 * PRESERVES — the third-party rows it moves onto a ghost listing.
 *
 * This is deliberately not "every reason this file defines". The scrub can only
 * ever see a reason that survived on such a row, which excludes:
 *
 * - `REASON_LISTING_CLOSED` / `REASON_LISTING_CLOSED_NO_CANDIDATE` /
 *   `REASON_LISTING_CANCELLED`: `close` and `cancel` settle the applications
 *   *before* the status flips, and a listing already out of circulation takes no
 *   new one, so nothing they wrote can still be sitting there when an account is
 *   erased. Listing them would imply a protection that no row can ever rely on.
 * - `REASON_CANDIDATE_UNAVAILABLE`: written by `releaseAcceptedPlacements` on
 *   the erased person's OWN applications, which are not preserved — they become
 *   `WITHDRAWN`. It lands on the practice's side of the exchange, never on a
 *   row this scrub reads.
 *
 * The two that remain are reachable: a listing closed while an application was
 * already rejected keeps its reason, and the erasure's own reason is written
 * after the scrub.
 *
 * A reason outside this list is treated as a practice's free text and erased,
 * which is the safe direction to be wrong in.
 */
export const PLATFORM_REJECTION_REASONS: string[] = [
  REASON_ANOTHER_CANDIDATE_SELECTED,
  REASON_LISTING_ERASED,
];

/**
 * The English spelling of `REASON_ANOTHER_CANDIDATE_SELECTED`, still present on
 * rows written before the reasons were translated. Listed so a row that predates
 * the translation is recognised as ours rather than erased as a practice's free
 * text.
 */
export const LEGACY_PLATFORM_REJECTION_REASONS: string[] = [
  "Another candidate was selected for this listing",
];

/**
 * What `releaseAcceptedPlacements` restores: the reason `accept` wrote when it
 * filled a listing, plus its historical spelling. Narrower than
 * `ALL_PLATFORM_REJECTION_REASONS` on purpose — restoring a row on a reason the
 * platform merely owns would be wrong, since it would put a candidate back in
 * the pipeline for a posting that no longer exists.
 */
export const AUTO_REJECTION_PLATFORM_REASONS: string[] = [
  REASON_ANOTHER_CANDIDATE_SELECTED,
  ...LEGACY_PLATFORM_REJECTION_REASONS,
];

export const ALL_PLATFORM_REJECTION_REASONS: string[] = [
  ...PLATFORM_REJECTION_REASONS,
  ...LEGACY_PLATFORM_REJECTION_REASONS,
];

/**
 * Every reason string this module can produce, for the reachability test. The
 * constants that are never written on a preserved row are absent on purpose —
 * see `PLATFORM_REJECTION_REASONS` — and the test asserts that reasoning rather
 * than inferring it from the list.
 */
export const ALL_REJECTION_REASON_STRINGS: string[] = [
  REASON_ANOTHER_CANDIDATE_SELECTED,
  REASON_LISTING_CLOSED,
  REASON_LISTING_CLOSED_NO_CANDIDATE,
  REASON_LISTING_CANCELLED,
  REASON_CANDIDATE_UNAVAILABLE,
  REASON_LISTING_ERASED,
  ...LEGACY_PLATFORM_REJECTION_REASONS,
];
