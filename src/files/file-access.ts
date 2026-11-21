import { APPLICABLE_LISTING_STATUSES } from "../common/listing-status";
import { getOwnedProfileIdSafe } from "../common/profile-lookup";
import type { Prisma, StoredFile } from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";

type AccessClient = PrismaService | Prisma.TransactionClient;
type Subject = Pick<
  StoredFile,
  "kind" | "profileId" | "listingId" | "applicationId"
>;

/**
 * Read policy for a stored file, as a pure data question.
 *
 * Denials are deliberately indistinguishable from a missing file at the HTTP
 * layer: a CV's existence must not be discoverable by enumerating file ids.
 */
export async function canReadFile(
  client: AccessClient,
  file: Subject,
  userId?: string,
): Promise<boolean> {
  const requesterProfileId = userId
    ? await getOwnedProfileIdSafe(client, userId)
    : undefined;

  switch (file.kind) {
    case "AVATAR": {
      if (!file.profileId) return false;
      if (requesterProfileId === file.profileId) return true;
      const profile = await client.profile.findUnique({
        where: { id: file.profileId },
        select: { isPublic: true },
      });
      return profile?.isPublic ?? false;
    }

    case "LISTING_IMAGE": {
      if (!file.listingId) return false;
      const listing = await client.replacementListing.findUnique({
        where: { id: file.listingId },
        select: {
          status: true,
          createdById: true,
          practice: { select: { isPublic: true, ownerId: true } },
        },
      });
      if (!listing) return false;

      // The creator and the practice owner both own the posting in practice.
      if (
        requesterProfileId &&
        (requesterProfileId === listing.createdById ||
          requesterProfileId === listing.practice.ownerId)
      ) {
        return true;
      }

      // The same visibility the public listing feed applies.
      return (
        listing.practice.isPublic &&
        APPLICABLE_LISTING_STATUSES.includes(listing.status)
      );
    }

    case "CV": {
      if (!requesterProfileId) return false;

      // The candidate's reusable CV is private to its owner.
      if (!file.applicationId) {
        return file.profileId === requesterProfileId;
      }

      const application = await client.application.findUnique({
        where: { id: file.applicationId },
        select: {
          applicantId: true,
          listing: { select: { practice: { select: { ownerId: true } } } },
        },
      });
      if (!application) return false;

      return (
        application.applicantId === requesterProfileId ||
        application.listing.practice.ownerId === requesterProfileId
      );
    }
  }
}
