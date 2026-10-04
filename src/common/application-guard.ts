import { ConflictException } from "@nestjs/common";
import type {
  ApplicationStatus,
  ListingStatus,
  Prisma,
} from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";
import {
  ACTIVE_APPLICATION_STATUSES,
  RECRUITING_LISTING_STATUSES,
} from "./listing-status";

/**
 * Statuses that must not be destroyed on someone else's behalf.
 *
 * `ACCEPTED` belongs here for the same reason as the active pair: `accept`
 * writes a real placement, and the cascade that erases the account would take
 * it — along with the message the candidate wrote and the decision the
 * practice made — without either of them ever being asked. A `FILLED` listing
 * carries exactly one of these, and it used to sail past the guard, which then
 * deleted a confirmed placement at purge time.
 *
 * The trade-off is deliberate: a practice with an accepted replacement can no
 * longer erase its account until that candidate withdraws, or the listing is
 * closed. That is the correct reading of "do not erase third-party data".
 */
export const PROTECTED_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
  "ACCEPTED",
];

type ApplicationClient = PrismaService | Prisma.TransactionClient;

/**
 * The listings a profile owns, directly or through a practice it owns.
 *
 * Written out three times over — here, in the erasure and in the profile
 * delete — which is how the two halves of the account teardown could disagree
 * about whose applications are at stake.
 */
export function ownedListingsFilter(
  ownerProfileId: string,
): Prisma.ReplacementListingWhereInput {
  return {
    OR: [
      { createdById: ownerProfileId },
      { practice: { ownerId: ownerProfileId } },
    ],
  };
}

/**
 * One message per call site, all naming the three statuses that block.
 *
 * The shared default said "pending applications", which stopped being true when
 * `ACCEPTED` joined the list: on `DELETE /profile/:id` or
 * `DELETE /practices/:id` it read as though a mere application could block the
 * deletion, and a caller following it would look for something to close while
 * the real blocker was a confirmed placement. Each site also says what actually
 * unblocks it, which is the same for all of them: taking the listing out of
 * `RECRUITING_LISTING_STATUSES`.
 *
 * The messages also say which of the two actions to use. `close` and `cancel`
 * are not interchangeable for the applicant: `close` reaches
 * `CLOSED_NO_CANDIDATE` from a listing that was still recruiting, and writes a
 * reason saying nobody was retained, whereas `cancel` writes one saying the
 * posting was dropped. Presenting them as alternatives without that difference
 * would leave a shortlisted candidate unable to tell the two outcomes apart.
 *
 * There is deliberately no account-erasure message. `confirmDeletion` does not
 * call this guard: it detaches those applications onto ghost listings first, so
 * the erasure can and must go through. The three endpoints below delete their
 * row outright, with no such step, so the guard is all that stands between them
 * and destroying someone else's application.
 */
const STATUS_LIST = "pending, shortlisted, or an accepted placement";

export const LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `This listing still has applications from other candidates (${STATUS_LIST}). ` +
  "Close it if the replacement was retained, or cancel it if you are giving up " +
  "on the replacement — the candidates are told which of the two it was, so the " +
  "choice is visible to them.";

export const PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `This practice still has listings with applications from other candidates (${STATUS_LIST}). ` +
  "Close or cancel those listings first — deleting the practice would erase them. " +
  "Close if the replacement was retained, cancel if you are giving up on it: " +
  "the candidates are told which.";

export const PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `Your listings still have applications from other candidates (${STATUS_LIST}). ` +
  "Close or cancel them first — deleting your profile would erase them. " +
  "Close if the replacement was retained, cancel if you are giving up on it: " +
  "the candidates are told which.";

/** Applications from other candidates that must survive this account's deletion. */
export function thirdPartyActiveApplicationsFilter(
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput = {},
): Prisma.ApplicationWhereInput {
  // A caller's own status filter would contradict the ACCEPTED branch, which
  // widens past the recruiting statuses on purpose. None passes one today.
  const { status: _callerStatus, ...restListingFilter } = listingFilter;

  return {
    AND: [
      {
        OR: [
          // An accepted placement counts whatever the listing went on to
          // become. `close` from FILLED takes the posting out of circulation
          // while the placement survives it, so a listing-status filter here
          // would let `close` then `remove` cascade a confirmed placement —
          // the exact harm the ACCEPTED entry above exists to prevent.
          {
            listing: restListingFilter,
            status: "ACCEPTED",
          },
          // The active pair only: those rows block a listing that still
          // recruits, and must not block one whose owner already took it out
          // of circulation.
          {
            listing: {
              ...restListingFilter,
              status: { in: RECRUITING_LISTING_STATUSES },
            },
            status: { in: ACTIVE_APPLICATION_STATUSES },
          },
        ],
      },
      { applicantId: { not: ownerProfileId } },
    ],
  };
}

/**
 * How many applications from other candidates sit on this account's listings.
 *
 * Every status, not just the ones the guard blocks: the erasure email tells the
 * person how many applications are being kept for the candidates who wrote
 * them, and a count that stopped at the recruiting statuses would understate it
 * — or report zero for an account whose only third-party applications were
 * rejected, right when that account most deserves to be told.
 */
export async function countThirdPartyApplications(
  prisma: ApplicationClient,
  userId: string,
): Promise<number> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!profile) {
    return 0;
  }

  return prisma.application.count({
    where: {
      listing: ownedListingsFilter(profile.id),
      applicantId: { not: profile.id },
    },
  });
}

/**
 * Refuses a deletion that would cascade away applications belonging to other
 * candidates.
 *
 * The cascade chain `User -> Profile -> Practice -> ReplacementListing ->
 * Application` deletes applications from third parties too, and that data is
 * not ours to erase on someone else's behalf.
 */
export async function assertNoThirdPartyApplications(
  prisma: ApplicationClient,
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput,
  message: string = PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
): Promise<void> {
  const count = await prisma.application.count({
    where: thirdPartyActiveApplicationsFilter(ownerProfileId, listingFilter),
  });

  if (count > 0) {
    throw new ConflictException(message);
  }
}
