import { BadRequestException } from "@nestjs/common";

/**
 * Stable identifiers for the refusals a caller can act on.
 *
 * The UI is French and the messages are sentences, so a client that wants to
 * say something specific has to recognise the refusal itself: parsing an English
 * message is how "this listing cannot be modified" and "only a draft can be
 * published" end up behind one branch. A code is the contract; the message is
 * copy.
 */
export const REFUSAL_CODES = {
  listingNotDraft: "LISTING_NOT_DRAFT",
  listingNotModifiable: "LISTING_NOT_MODIFIABLE",
  listingInvalidDates: "LISTING_INVALID_DATES",
  listingNotCloseable: "LISTING_NOT_CLOSEABLE",
  listingAlreadyClosed: "LISTING_ALREADY_CLOSED",
  listingFilledCannotBeDeleted: "LISTING_FILLED_CANNOT_BE_DELETED",
  listingHasThirdPartyApplications: "LISTING_HAS_THIRD_PARTY_APPLICATIONS",
  listingQuotaReached: "LISTING_QUOTA_REACHED",
  practiceHasThirdPartyApplications: "PRACTICE_HAS_THIRD_PARTY_APPLICATIONS",
  profileHasThirdPartyApplications: "PROFILE_HAS_THIRD_PARTY_APPLICATIONS",
  applicationNotPending: "APPLICATION_NOT_PENDING",
  applicationNotShortlistable: "APPLICATION_NOT_SHORTLISTABLE",
  applicationNotAcceptable: "APPLICATION_NOT_ACCEPTABLE",
  applicationNotRejectable: "APPLICATION_NOT_REJECTABLE",
  applicationNotWithdrawable: "APPLICATION_NOT_WITHDRAWABLE",
  applicationNotListingOwner: "APPLICATION_NOT_LISTING_OWNER",
  applicationListingNotAccepting: "APPLICATION_LISTING_NOT_ACCEPTING",
  applicationListingLimitReached: "APPLICATION_LISTING_LIMIT_REACHED",
  applicationAlreadyExists: "APPLICATION_ALREADY_EXISTS",
  applicationQuotaReached: "APPLICATION_QUOTA_REACHED",
} as const;

export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES];

/** A 400 whose body carries the code alongside the message. */
export function refusal(
  code: RefusalCode,
  message: string,
): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}
