import { ownedListingsFilter } from "../common/application-guard";
import { ACTIVE_APPLICATION_STATUSES } from "../common/listing-status";
import type { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";
import { verificationRowsForIdentity } from "./deletion-token";

/**
 * A `cuid`-shaped id nothing can hold, so a where clause can ask for "no
 * listing" or "no profile" without branching the query.
 *
 * `id` is TEXT and unconstrained, which is what makes this safe: it is not a
 * reserved value the database would reject, and nothing enumerates ids that could
 * collide with it.
 */
const NO_SUCH_LISTING_ID = "__no_such_listing__";
const NO_SUCH_PROFILE_ID = "__no_such_profile__";

import { detachThirdPartyApplications } from "./ghost-listing";

type Client = PrismaService | Prisma.TransactionClient;

/**
 * The replacement for an erased person's own free text.
 *
 * A listing whose title, description and dates are scrubbed still has to satisfy
 * the schema, and still has to be recognisable in the owner's own list as "the
 * one you erased" rather than as an empty row that looks like a bug.
 */
export const ANONYMIZED_LISTING_TITLE = "Withdrawn listing";
export const ANONYMIZED_DESCRIPTION = "Withdrawn at the request of its author.";
const ANONYMIZED_DATE = new Date("1970-01-01T00:00:00.000Z");

/**
 * An email that satisfies the unique index without identifying anyone.
 *
 * Keyed by the user fingerprint, so two erasures never collide and neither
 * address carries a hint of the original one.
 */
export function anonymizedEmail(userIdHash: string): string {
  return `erased-${userIdHash.slice(0, 32)}@deleted.invalid`;
}

export interface ErasureOutcome {
  /** Third-party applications moved onto the ghost listing rather than destroyed. */
  detachedApplications: number;
  /** Own listings taken out of circulation. */
  anonymizedListings: number;
  /** Own applications settled so their listing recalculates. */
  settledApplications: number;
  /** Listings that carried a placement: kept until the placement is resolved. */
  protectedPlacements: number;
}

/**
 * Anonymizes one account in place, inside the caller's transaction.
 *
 * The row is kept rather than deleted: the cascade would take the applications
 * other candidates wrote on this person's listings, and that data is not ours to
 * erase on their behalf. `deletedAt` is what marks the row, and the purge sweep
 * drops it once the grace period has passed.
 */
export async function anonymizeAccount(
  prisma: Client,
  input: {
    userId: string;
    email: string;
    userIdHash: string;
  },
): Promise<ErasureOutcome> {
  const { userId, email, userIdHash } = input;

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { id: true },
  });

  // The same filter the third-party guard uses, plus the branch for a profile
  // that is already gone: there is nothing to own, so nothing may match, and a
  // sentinel id is how a where clause says "none" without a second query.
  const practiceFilter = profile
    ? ownedListingsFilter(profile.id)
    : { id: NO_SUCH_LISTING_ID };

  const listingIds = await prisma.replacementListing.findMany({
    where: practiceFilter,
    select: { id: true, status: true },
  });

  // Before anything is scrubbed: the applications other candidates wrote are
  // moved onto a ghost listing, so neither they nor the practice that received
  // them lose the thread.
  const detachment = profile
    ? await detachThirdPartyApplications(prisma, {
        ownerProfileId: profile.id,
        listingIds: listingIds.map((listing) => listing.id),
      })
    : { ghostListingId: "", detachedApplications: 0 };

  // A listing holding an accepted placement stays as it is: the placement is a
  // real one, agreed with a candidate, and the candidate is still waiting for an
  // answer. It leaves circulation instead of being scrubbed.
  const protectedListingIds = listingIds
    .filter((listing) => listing.status === "FILLED")
    .map((listing) => listing.id);

  const openListingIds = listingIds
    .filter((listing) => listing.status !== "FILLED")
    .map((listing) => listing.id);

  if (openListingIds.length > 0) {
    await prisma.replacementListing.updateMany({
      where: { id: { in: openListingIds } },
      data: {
        title: ANONYMIZED_LISTING_TITLE,
        description: ANONYMIZED_DESCRIPTION,
        startDate: ANONYMIZED_DATE,
        endDate: ANONYMIZED_DATE,
        status: "CLOSED_NO_CANDIDATE",
        urgent: false,
      },
    });

    await prisma.application.updateMany({
      where: { listingId: { in: openListingIds }, status: "PENDING" },
      data: {
        status: "REJECTED",
        decisionSource: "SYSTEM",
        rejectionReason: null,
        respondedAt: new Date(),
      },
    });
  }

  const settledApplications = await prisma.application.updateMany({
    where: profile
      ? { applicantId: profile.id, status: { in: ACTIVE_APPLICATION_STATUSES } }
      : { applicantId: NO_SUCH_PROFILE_ID },
    data: {
      status: "WITHDRAWN",
      decisionSource: "SYSTEM",
      message: null,
      withdrawnReason: null,
      respondedAt: new Date(),
    },
  });

  if (profile) {
    await prisma.profile.update({
      where: { id: profile.id },
      data: {
        rppsNumber: null,
        city: null,
        latitude: null,
        longitude: null,
        isPublic: false,
        verified: false,
      },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      email: anonymizedEmail(userIdHash),
      name: null,
      image: null,
      emailVerified: false,
      deletedAt: new Date(),
    },
  });

  await prisma.session.deleteMany({ where: { userId } });
  await prisma.account.deleteMany({ where: { userId } });

  // `verification` has no foreign key to `user`: without this purge, the tokens
  // tied to the erased identity — email verification and password reset, both
  // indexed by the raw address — would outlive it and keep it reachable.
  await prisma.verification.deleteMany({
    where: verificationRowsForIdentity(email, userId),
  });

  return {
    detachedApplications: detachment.detachedApplications,
    anonymizedListings: openListingIds.length,
    settledApplications: settledApplications.count,
    protectedPlacements: protectedListingIds.length,
  };
}
