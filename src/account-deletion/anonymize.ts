import { ownedListingsFilter } from "../common/application-guard";
import {
  ACTIVE_APPLICATION_STATUSES,
  isTerminalListingStatus,
  recalcListingStatus,
} from "../common/listing-status";
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
 * What a practice name becomes.
 *
 * `name` is not nullable, so it cannot be blanked the way the profile's fields
 * are. The string says nothing and identifies nobody, and `isPublic` is what
 * actually takes the row out of circulation.
 */
const ANONYMIZED_PRACTICE_FIELD = "Erased with its owner";

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
  /** Own listings rewritten out of circulation (already-terminal ones excluded). */
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

  const listings = await prisma.replacementListing.findMany({
    where: practiceFilter,
    select: { id: true, status: true },
  });

  // Before anything is scrubbed: the applications other candidates wrote are
  // moved onto a ghost listing, so neither they nor the practice that received
  // them lose the thread.
  //
  // A listing holding an accepted placement is left out of the move: the
  // candidate waiting on it is waiting for *that* listing — its practice, its
  // dates — and parking their application on a `1970` placeholder would sever
  // the thread from the placement it agreed on. A FILLED listing carries no
  // active application — `accept` settles the others the moment it lands — so
  // nothing undecided is stranded behind this.
  const detachableListingIds = listings
    .filter((listing) => listing.status !== "FILLED")
    .map((listing) => listing.id);

  const detachment = profile
    ? await detachThirdPartyApplications(prisma, {
        ownerProfileId: profile.id,
        listingIds: detachableListingIds,
      })
    : { ghostListingIds: [], applicationIds: [], detachedApplications: 0 };

  // A candidacy the erased account would have decided — PENDING or SHORTLISTED
  // — can never be decided now, and one left open on its ghost would sit there
  // queueing the candidate's own application quota for nothing. Settled here,
  // inside the same transaction, with the decision attributed to the system
  // rather than to a practice that never answered; the row stays readable in
  // `findMine`, which is what keeps the thread those candidates were told they
  // keep.
  if (detachment.applicationIds.length > 0) {
    await prisma.application.updateMany({
      where: {
        id: { in: detachment.applicationIds },
        status: { in: ACTIVE_APPLICATION_STATUSES },
      },
      data: {
        status: "REJECTED",
        decisionSource: "SYSTEM",
        rejectionReason: null,
        respondedAt: new Date(),
      },
    });
  }

  // A listing still looking for a locum — DRAFT, OPEN, IN_DISCUSSION, FULL —
  // leaves circulation: nobody can answer a posting whose author is gone, and
  // a scrubbed title alone would leave it findable anyway.
  const circulatingListingIds = listings
    .filter((listing) => !isTerminalListingStatus(listing.status))
    .map((listing) => listing.id);

  if (circulatingListingIds.length > 0) {
    await prisma.replacementListing.updateMany({
      where: { id: { in: circulatingListingIds } },
      data: {
        title: ANONYMIZED_LISTING_TITLE,
        description: ANONYMIZED_DESCRIPTION,
        startDate: ANONYMIZED_DATE,
        endDate: ANONYMIZED_DATE,
        status: "CLOSED_NO_CANDIDATE",
        urgent: false,
      },
    });
  }

  // Already-terminal ones keep the status their owner chose: rewriting a
  // CANCELLED listing to CLOSED_NO_CANDIDATE used to erase the difference the
  // owner drew between "closed after a replacement" and "withdrawn", and
  // history is part of what an accountability record is for. What goes is the
  // owner's own words, and nothing else about the row. This sweep covers a
  // protected placement too: the placement stays, the erased person's text
  // does not.
  const sealedListingIds = listings
    .filter((listing) => isTerminalListingStatus(listing.status))
    .map((listing) => listing.id);

  if (sealedListingIds.length > 0) {
    await prisma.replacementListing.updateMany({
      where: { id: { in: sealedListingIds } },
      data: {
        title: ANONYMIZED_LISTING_TITLE,
        description: ANONYMIZED_DESCRIPTION,
        urgent: false,
      },
    });
  }

  // The listings this account's own applications sit on, read before the
  // settling below so the ids survive the write that makes them ineligible.
  const ownActiveListings = profile
    ? await prisma.application.findMany({
        where: {
          applicantId: profile.id,
          status: { in: ACTIVE_APPLICATION_STATUSES },
        },
        select: { listingId: true },
      })
    : [];

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

  // The recount the settled status promises. A FULL listing whose freed slot
  // rests on this account's withdrawn application stays FULL forever without
  // it — refusing every candidate although a place re-opened — and an
  // IN_DISCUSSION one keeps looking undecided to a feed that only shows the
  // statuses a candidate may answer. The recount runs inside this same
  // transaction, like every other write here.
  const recountedListingIds = [
    ...new Set(ownActiveListings.map(({ listingId }) => listingId)),
  ];
  for (const listingId of recountedListingIds) {
    await recalcListingStatus(prisma, listingId);
  }

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

    // The practices this profile owned.
    //
    // They were the one thing an erasure walked past: `user`, `profile`,
    // `replacementListing` and `application` were all scrubbed, so a practice
    // kept its real name, its real address and its coordinates, and stayed
    // `isPublic` — still listed in `GET /practices` and still in the geographic
    // index, for the whole `ACCOUNT_PURGE_GRACE_DAYS` window, pointing at a
    // profile whose fields were all null.
    //
    // Coordinates are cleared rather than moved: a `lat`/`lng` of zero is a real
    // place in the Atlantic, and an indexed practice there is worse than one that
    // has left the `latitude IS NOT NULL` branch of the geo query entirely.
    await prisma.practice.updateMany({
      where: { ownerId: profile.id },
      data: {
        name: ANONYMIZED_PRACTICE_FIELD,
        address: ANONYMIZED_PRACTICE_FIELD,
        city: ANONYMIZED_PRACTICE_FIELD,
        latitude: null,
        longitude: null,
        isPublic: false,
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

  // A listing that carried a placement is not counted as anonymized: it did
  // not leave circulation, only its words did.
  const placementListingIds = listings
    .filter((listing) => listing.status === "FILLED")
    .map((listing) => listing.id);

  return {
    detachedApplications: detachment.detachedApplications,
    anonymizedListings: circulatingListingIds.length,
    settledApplications: settledApplications.count,
    protectedPlacements: placementListingIds.length,
  };
}
