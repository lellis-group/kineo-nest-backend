import type { Prisma } from "../generated/prisma/client";
import type {
  ApplicationStatus,
  ListingStatus,
} from "../generated/prisma/enums";

/**
 * Statuses of an application that still occupies a slot on its listing.
 *
 * Exported because the third-party deletion guard has to draw the same line: it
 * exempts an application once it stops holding capacity, and an ACCEPTED one
 * for a different reason entirely.
 */
export const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
];

/**
 * Statuses a listing has not yet left for good.
 *
 * A listing in one of them is still in play, so applications on it still block
 * their owner's deletion. CLOSED and CANCELLED took it out of circulation, and a
 * PENDING row left on it is a leftover that must not keep the owner blocked.
 * FILLED belongs here rather than with the terminal statuses: it carries the
 * accepted placement the guard protects.
 */
export const RECRUITING_LISTING_STATUSES: ListingStatus[] = [
  "DRAFT",
  "OPEN",
  "IN_DISCUSSION",
  "FULL",
  "FILLED",
];

/**
 * Statuses a listing can no longer leave.
 *
 * `close` and `cancel` each used to redraw their own list, which is how `close`
 * ended up rejecting the two statuses that hold active applications while
 * `cancel` accepted FILLED.
 */
export const TERMINAL_LISTING_STATUSES: ListingStatus[] = [
  "FILLED",
  "CLOSED",
  "CLOSED_NO_CANDIDATE",
  "CANCELLED",
];

/** Statuses a listing never enters through a recount. */
export const MANUAL_LISTING_STATUSES: ListingStatus[] = ["DRAFT"];

export function isTerminalListingStatus(status: ListingStatus): boolean {
  return TERMINAL_LISTING_STATUSES.includes(status);
}

export function isRecruitingListingStatus(status: ListingStatus): boolean {
  return RECRUITING_LISTING_STATUSES.includes(status);
}

/**
 * The status a listing's own applications imply.
 *
 * Written out three times before this existed — once when an application
 * arrives, once when it is settled, and once inline in the quota check — and the
 * copies agreed by coincidence, with nothing pinning it. The status is derived
 * state: one rule, one place.
 *
 * A terminal status is returned untouched, so a recount never resurrects a
 * listing its owner took out of circulation, and DRAFT is returned untouched
 * because staying unpublished is the owner's decision, not a function of the
 * application count.
 */
export function deriveListingStatus(input: {
  current: ListingStatus;
  activeApplications: number;
  maxApplications: number | null;
}): ListingStatus {
  const { current, activeApplications, maxApplications } = input;

  if (
    isTerminalListingStatus(current) ||
    MANUAL_LISTING_STATUSES.includes(current)
  ) {
    return current;
  }

  if (activeApplications === 0) {
    return "OPEN";
  }

  if (maxApplications && activeApplications >= maxApplications) {
    return "FULL";
  }

  return "IN_DISCUSSION";
}

/** Listing statuses a candidate may still answer, in the order the UI shows them. */
export const APPLICABLE_LISTING_STATUSES: ListingStatus[] = [
  "OPEN",
  "IN_DISCUSSION",
];

/**
 * Recomputes a listing's status from its applications, and writes it if it moved.
 *
 * The rule is `deriveListingStatus`, which is pure and lives above; this is the
 * part that needs a client. It was a private method on the applications service,
 * which meant the listings service could not reach it — and so could not react to
 * a change of `maxApplications`, which is one of the two inputs. A `FULL` listing
 * whose owner raised the cap stayed `FULL` and refused every candidate it had
 * room for, with no transition able to undo it.
 *
 * Takes the caller's client so the count and the write share a transaction: read
 * the status, count the applications, write the new status, and the two reads have
 * to agree about what they saw.
 */
export async function recalcListingStatus(
  tx: Prisma.TransactionClient,
  listingId: string,
) {
  const listing = await tx.replacementListing.findUnique({
    where: { id: listingId },
  });

  if (!listing) {
    return;
  }

  const activeApplications = await tx.application.count({
    where: { listingId, status: { in: ACTIVE_APPLICATION_STATUSES } },
  });

  const status = deriveListingStatus({
    current: listing.status,
    activeApplications,
    maxApplications: listing.maxApplications,
  });

  if (status !== listing.status) {
    await tx.replacementListing.update({
      where: { id: listingId },
      data: { status },
    });
  }
}
