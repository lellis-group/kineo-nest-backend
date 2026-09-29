import { ConflictException } from "@nestjs/common";
import type {
  ApplicationStatus,
  ListingStatus,
  Prisma,
} from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";

const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
];

/**
 * Statuses that no longer recruit candidates. A listing in one of them cannot
 * receive a new application, so any `PENDING` row it still carries is a
 * leftover from before the listing left circulation and must not keep its owner
 * blocked from deleting.
 */
const RECRUITING_LISTING_STATUSES: ListingStatus[] = [
  "DRAFT",
  "OPEN",
  "IN_DISCUSSION",
  "FULL",
  "FILLED",
];

const DEFAULT_CONFLICT_MESSAGE =
  "This resource has pending applications from other candidates. Close or cancel the linked listings before deleting it.";

/**
 * Refuses a deletion that would cascade away applications belonging to other
 * candidates.
 *
 * The cascade chain `User -> Profile -> Practice -> ReplacementListing ->
 * Application` deletes applications from third parties too, and that data is
 * not ours to erase on someone else's behalf.
 */
export async function assertNoThirdPartyApplications(
  prisma: PrismaService,
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput,
  message: string = DEFAULT_CONFLICT_MESSAGE,
): Promise<void> {
  const count = await prisma.application.count({
    where: {
      listing: {
        ...listingFilter,
        status: { in: RECRUITING_LISTING_STATUSES },
      },
      applicantId: { not: ownerProfileId },
      status: { in: ACTIVE_APPLICATION_STATUSES },
    },
  });

  if (count > 0) {
    throw new ConflictException(message);
  }
}
