import type { ApplicationStatus, ListingStatus } from "../generated/prisma/enums";
import type { Prisma } from "../generated/prisma/client";

/** Statuses that keep a listing open to new candidates. */
const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
];

/** Statuses a listing can no longer leave. */
const TERMINAL_LISTING_STATUSES: ListingStatus[] = [
  "FILLED",
  "CLOSED",
  "CANCELLED",
];

/**
 * Recomputes a listing's status from the applications it still holds.
 *
 * The status is derived state, never an independent fact: it exists so a
 * listing can be filtered on (`findAll` only surfaces `OPEN`) and so
 * `create` can refuse a candidate on a full listing. Any write that moves an
 * application in or out of the active set must therefore go through here, or
 * the listing keeps advertising capacity it no longer has.
 *
 * Lives in `common/` rather than in `ApplicationsService` because the account
 * erasure reaches it from outside: anonymizing an applicant clears the active
 * applications they held on other people's listings, which frees capacity
 * those owners are entitled to.
 *
 * @param includeFilled Recalculate even when the listing is `FILLED`, so an
 * erasure can reopen a listing whose selected candidate left. `CLOSED` and
 * `CANCELLED` are never reopened: their owner took the listing out of
 * circulation on purpose.
 */
export async function recalcListingStatus(
  tx: Prisma.TransactionClient,
  listingId: string,
  { includeFilled = false }: { includeFilled?: boolean } = {},
): Promise<void> {
  const listing = await tx.replacementListing.findUnique({
    where: { id: listingId },
  });

  if (!listing) {
    return;
  }

  const terminal = includeFilled
    ? TERMINAL_LISTING_STATUSES.filter((status) => status !== "FILLED")
    : TERMINAL_LISTING_STATUSES;

  if (terminal.includes(listing.status)) {
    return;
  }

  const activeCount = await tx.application.count({
    where: { listingId, status: { in: ACTIVE_APPLICATION_STATUSES } },
  });

  let nextStatus: ListingStatus = listing.status;

  if (activeCount === 0) {
    nextStatus = "OPEN";
  } else if (
    listing.maxApplications &&
    activeCount >= listing.maxApplications
  ) {
    nextStatus = "FULL";
  } else {
    nextStatus = "IN_DISCUSSION";
  }

  if (nextStatus !== listing.status) {
    await tx.replacementListing.update({
      where: { id: listingId },
      data: { status: nextStatus },
    });
  }
}
