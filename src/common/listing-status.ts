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
