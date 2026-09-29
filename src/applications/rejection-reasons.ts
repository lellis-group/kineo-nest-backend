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

/** Written when the owner cancels a listing that still holds applications. */
export const REASON_LISTING_CANCELLED = "L'annonce a été annulée";

/**
 * Written on the accepted application when the candidate is erased before the
 * replacement happens. Their data is gone, so the practice is told the
 * candidate is no longer available rather than anything about the erasure.
 */
export const REASON_CANDIDATE_UNAVAILABLE =
  "Ce candidat n'est plus disponible";
