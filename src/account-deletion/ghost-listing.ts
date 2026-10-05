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
  ghostListingIds: string[];
  detachedApplications: number;
}

/**
 * One ghost listing per original listing.
 *
 * Not per account, and that is the whole point. `application` carries
 * `@@unique([listingId, applicantId])`, so moving two applications from the same
 * candidate onto a single ghost makes them two rows with the same pair. The write
 * is rejected with `P2002`, the whole erasure transaction rolls back, and the
 * account can never be erased by that link again — permanently, and with nothing
 * in the response to say why.
 *
 * A candidate who applied to two of the erased account's postings is the ordinary
 * case, not an edge one.
 *
 * The id is derived from the original listing rather than generated, so a retried
 * erasure finds the ghost it already made instead of adding another. The id is
 * TEXT and unconstrained, so there is nothing to collide with.
 */
function ghostListingIdFor(originalListingId: string): string {
  return `ghost-for-${originalListingId}`;
}

/**
 * Moves the applications other candidates wrote on an erased account's listings
 * onto ghost listings.
 *
 * The erasure rewrites its own listings rather than deleting them, but the
 * anonymized listing is closed and scrubbed: the candidate who applied would lose
 * the thread telling them what happened to their application, and the practice
 * that received it would see a row pointing at a placeholder. Both keep a real
 * row, on a listing that exists precisely to hold them.
 *
 * The ghosts belong to the system profile, so the purge sweep never collects them:
 * they live as long as the applications they carry, which is what should happen.
 *
 * Idempotent: a ghost's id is a function of the listing it was made for, so
 * running this twice for the same account detaches nothing new.
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

  const ghostListingIds: string[] = [];
  let detachedApplications = 0;

  for (const listingId of listingIds) {
    // Per listing rather than across all of them, because the destination differs
    // per listing. The batch that used to move everything at once is what the
    // unique index rejects.
    const applications = await prisma.application.findMany({
      where: {
        listingId,
        applicantId: { not: ownerProfileId },
        status: { in: [...PRESERVED_APPLICATION_STATUSES] },
      },
      select: { id: true },
    });

    if (applications.length === 0) {
      continue;
    }

    const ghostId = ghostListingIdFor(listingId);

    await prisma.replacementListing.upsert({
      where: { id: ghostId },
      create: {
        id: ghostId,
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
      // The ghost is a placeholder and its content is fixed, so a repeat run has
      // nothing to change: `{}` keeps the row as it was rather than rewriting it.
      update: {},
    });

    await prisma.application.updateMany({
      where: { id: { in: applications.map((application) => application.id) } },
      data: { listingId: ghostId },
    });

    ghostListingIds.push(ghostId);
    detachedApplications += applications.length;
  }

  return { ghostListingIds, detachedApplications };
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
