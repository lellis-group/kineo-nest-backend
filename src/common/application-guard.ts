import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";
import {
  ACTIVE_APPLICATION_STATUSES,
  RECRUITING_LISTING_STATUSES,
} from "./listing-status";

type ApplicationClient = PrismaService | Prisma.TransactionClient;

/**
 * Statuses that must not be destroyed on someone else's behalf, spelled out
 * where they are enforced rather than in a list of their own.
 *
 * ACCEPTED is protected because accept writes a real placement: the cascade
 * would take it, along with the message the candidate wrote and the decision
 * the practice made, without either of them being asked. It also outlives the
 * statuses that merely hold a slot, so the guard draws the line in two branches
 * — see `thirdPartyActiveApplicationsFilter`. A single exported list of the
 * three used to sit here, matching neither branch, and agreeing with the guard
 * only by coincidence.
 */
const STATUS_LIST = "pending, shortlisted, or an accepted placement";

export const LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `This listing still has applications from other candidates (${STATUS_LIST}). ` +
  "Close it if the replacement was retained, or cancel it if you are giving up " +
  "on the replacement — the candidates are told which of the two it was.";

export const PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `This practice still has listings with applications from other candidates (${STATUS_LIST}). ` +
  "Close or cancel those listings first — deleting the practice would erase them.";

export const PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE =
  `Your listings still have applications from other candidates (${STATUS_LIST}). ` +
  "Close or cancel them first — deleting your profile would erase them.";

/**
 * The listings a profile owns, directly or through a practice it owns.
 *
 * Written out three times over — here, in the practice delete and in the
 * profile delete — which is how the two halves of the account teardown could
 * disagree about whose applications are at stake.
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

/** Applications from other candidates that must survive this account's deletion. */
export function thirdPartyActiveApplicationsFilter(
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput = {},
): Prisma.ApplicationWhereInput {
  // A caller's own status filter would contradict the ACCEPTED branch, which
  // widens past the recruiting statuses on purpose.
  const { status: _callerStatus, ...restListingFilter } = listingFilter;

  return {
    AND: [
      {
        OR: [
          // An accepted placement counts whatever the listing went on to
          // become, so it is checked without a listing-status filter.
          { listing: restListingFilter, status: "ACCEPTED" },
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
 * Every status, not only the ones the guard blocks: the erasure email tells the
 * person how many applications are being kept for the candidates who wrote them,
 * and a count that stopped at the recruiting statuses would understate it — or
 * report zero for an account whose only third-party applications had been
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
 * The chain `Profile -> Practice -> ReplacementListing -> Application` deletes
 * applications from third parties too, and that data is not ours to erase on
 * someone else's behalf.
 */
export async function assertNoThirdPartyApplications(
  prisma: ApplicationClient,
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput = {},
  message: string = PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
): Promise<void> {
  const count = await prisma.application.count({
    where: thirdPartyActiveApplicationsFilter(ownerProfileId, listingFilter),
  });

  if (count > 0) {
    throw new ConflictException(message);
  }
}
