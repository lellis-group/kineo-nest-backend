import { ACTIVE_APPLICATION_STATUSES } from "../common/listing-status";
import {
  GHOST_LISTING_TITLE,
  SYSTEM_SCAFFOLD,
} from "../common/system-scaffold";
import type { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";

type Client = PrismaService | Prisma.TransactionClient;

/**
 * The statuses whose applications must survive their listing's owner.
 *
 * PENDING and SHORTLISTED still hold capacity; ACCEPTED is a placement that was
 * agreed with the candidate. A REJECTED or WITHDRAWN row is already settled and
 * carries nothing the candidate is waiting for, so it is destroyed with the rest.
 */
export const PRESERVED_APPLICATION_STATUSES = [
  ...ACTIVE_APPLICATION_STATUSES,
  "ACCEPTED",
] as const;

export interface DetachmentOutcome {
  ghostListingId: string;
  detachedApplications: number;
}

/**
 * Moves the applications other candidates wrote on an erased account's listings
 * onto a ghost listing.
 *
 * The erasure rewrites its own listings rather than deleting them, but the
 * anonymized listing is closed and scrubbed: the candidate who applied would lose
 * the thread telling them what happened to their application, and the practice
 * that received it would see a row pointing at a placeholder. Both keep a real
 * row, on a listing that exists precisely to hold them.
 *
 * Idempotent: a listing created for this account is reused, so a retried erasure
 * does not accumulate ghosts.
 */
export async function detachThirdPartyApplications(
  prisma: Client,
  input: {
    /** The profile of the account being erased. */
    ownerProfileId: string;
    /** Only listings of this owner are considered. */
    listingIds: string[];
  },
): Promise<DetachmentOutcome> {
  const { ownerProfileId, listingIds } = input;

  const scaffold = await prisma.practice.findUnique({
    where: { id: SYSTEM_SCAFFOLD.practiceId },
    select: { id: true },
  });

  if (!scaffold) {
    // Failing loudly is the point: without the scaffold the applications would
    // either be destroyed or silently reparented onto a random practice.
    throw new ServiceUnavailableScaffoldError();
  }

  const applications = await prisma.application.findMany({
    where: {
      listingId: { in: listingIds },
      applicantId: { not: ownerProfileId },
      status: { in: [...PRESERVED_APPLICATION_STATUSES] },
    },
    select: { id: true, listingId: true },
  });

  if (applications.length === 0) {
    return { ghostListingId: "", detachedApplications: 0 };
  }

  const existing = await prisma.replacementListing.findFirst({
    where: {
      createdById: SYSTEM_SCAFFOLD.profileId,
      title: GHOST_LISTING_TITLE,
    },
    select: { id: true },
  });

  const ghost =
    existing ??
    (await prisma.replacementListing.create({
      data: {
        practiceId: SYSTEM_SCAFFOLD.practiceId,
        createdById: SYSTEM_SCAFFOLD.profileId,
        title: GHOST_LISTING_TITLE,
        description:
          "This listing is the placeholder left by an account erasure. The applications it holds belong to their authors, who keep access to them.",
        startDate: new Date("1970-01-01T00:00:00.000Z"),
        endDate: new Date("1970-01-01T00:00:00.000Z"),
        specialty: "GENERALIST",
        status: "CLOSED_NO_CANDIDATE",
        urgent: false,
      },
      select: { id: true },
    }));

  await prisma.application.updateMany({
    where: { id: { in: applications.map((application) => application.id) } },
    data: { listingId: ghost.id },
  });

  return {
    ghostListingId: ghost.id,
    detachedApplications: applications.length,
  };
}

/** Raised when the deployment never ran the seed that creates the scaffold. */
export class ServiceUnavailableScaffoldError extends Error {
  constructor() {
    super(
      "the system scaffold is missing: run `bun run db:seed` so third-party applications have somewhere to be parked",
    );
    this.name = "ServiceUnavailableScaffoldError";
  }
}
