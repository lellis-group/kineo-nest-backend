import { describe, expect, it } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApplicationsService } from "../applications/applications.service";
import { ListingStatus } from "../generated/prisma/enums";
import type { PrismaService } from "../prisma.service";
import { ReplacementlistingsService } from "../replacementlistings/replacementlistings.service";

/**
 * One table of truth for what every guard does, per listing status.
 *
 * Why this file exists
 * --------------------
 * Four guards used to redraw the same list of statuses independently, and they
 * disagreed. `close` and `cancel` were centralised on `TERMINAL_LISTING_STATUSES`
 * while `update` and `accept` kept a hand-written list — and that list was
 * missing `CLOSED_NO_CANDIDATE`, so the owner could edit a posting they had
 * already closed. The commit that centralised two of the four stated it had
 * centralised them all.
 *
 * Nothing caught it, because each guard had its own hand-written test case, and
 * a hand-written test only knows about the statuses its author remembered.
 * `CLOSED_NO_CANDIDATE` was added to the enum by a later commit; the guards
 * that predated it were never revisited.
 *
 * A table inverts that. The decision for every (guard, status) pair is written
 * down once, in full, next to the enum, and a status nobody classified is a
 * type error rather than a silent gap. That is the whole mechanism.
 */

const ALL_STATUSES = Object.values(ListingStatus);

type Decision = "refused" | "allowed";

/**
 * The table. Read it as: "from this status, does this action get through?"
 *
 * `update` and `accept` share their column on purpose — they ask the same
 * question ("may this listing still change?") and the test asserts they agree
 * on every status, which is the invariant that was broken.
 */
const GUARDS = {
  /** `PATCH /replacement-listings/:id` */
  update: {
    DRAFT: "allowed",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    // A filled listing carries a confirmed placement.
    FILLED: "refused",
    CLOSED: "refused",
    // The one that was missing.
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
  /** `PATCH /replacement-listings/:id/close` */
  close: {
    DRAFT: "refused",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    // FILLED is the one terminal status `close` accepts: the placement is
    // already written, and closing is how its owner takes the posting out of
    // circulation without disturbing it.
    FILLED: "allowed",
    CLOSED: "refused",
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
  /** `PATCH /replacement-listings/:id/cancel` */
  cancel: {
    DRAFT: "allowed",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    // Refused: cancelling a filled listing would leave the accepted candidate
    // holding a placement on a posting that no longer exists.
    FILLED: "refused",
    CLOSED: "refused",
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
  /** `PATCH /applications/:id/accept` */
  accept: {
    // DRAFT is the one status where this guard and `update` disagree, and the
    // disagreement is not a bug. `update` has to allow it — editing a draft is
    // the normal thing to do before publishing. `accept` has no business
    // forbidding it either way: a DRAFT holds no applications by construction,
    // so no application on one can exist to be accepted. The row reads
    // "allowed" because that is what the guard does, not because the case is
    // reachable. The agreement test below scopes around this one status.
    DRAFT: "allowed",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    FILLED: "refused",
    CLOSED: "refused",
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
} as const satisfies Record<string, Record<ListingStatus, Decision>>;

const OWNER = { id: "profile-owner", userId: "user-owner" };

function aListing(status: ListingStatus) {
  return {
    id: "listing-1",
    practiceId: "practice-1",
    createdById: OWNER.id,
    title: "Remplacement",
    startDate: new Date("2026-09-10T08:00:00.000Z"),
    endDate: new Date("2026-09-12T08:00:00.000Z"),
    specialty: "GENERALIST" as const,
    status,
    urgent: false,
    description: null,
    maxApplications: null,
    createdAt: new Date("2026-08-20T08:00:00.000Z"),
    updatedAt: new Date("2026-08-20T08:00:00.000Z"),
  };
}

/**
 * Drives a listing service with one listing in one status.
 *
 * Only the reads the guards perform are implemented. Every write flips a flag
 * rather than returning a value, because the interesting assertion is not "did
 * it succeed" but "did it touch a row at all" — a guard that let a refused
 * request through to the database would still be a bug.
 */
function listingsService(status: ListingStatus) {
  const listing = aListing(status);
  let wrote = false;

  const transactionClient = {
    profile: { findUnique: async () => OWNER },
    replacementListing: {
      findUnique: async () => listing,
      // `close` and `cancel` return the row their `update` produced, with the
      // application count attached, and `update`'s capacity branch re-reads it
      // the same way. Both need the `_count` the service destructures, so
      // every path that reaches the end of the happy path returns it.
      findUniqueOrThrow: async () => ({
        ...listing,
        _count: { applications: 0 },
      }),
      update: async () => {
        wrote = true;
        return { ...listing, _count: { applications: 0 } };
      },
    },
    application: {
      count: async () => 0,
      updateMany: async () => {
        wrote = true;
        return { count: 0 };
      },
    },
  };

  const prisma = {
    profile: { findUnique: async () => OWNER },
    $transaction: async (
      operation: (tx: typeof transactionClient) => unknown,
    ) => operation(transactionClient),
  } as unknown as PrismaService;

  const config = { get: () => undefined } as unknown as ConfigService;

  return {
    service: new ReplacementlistingsService(prisma, config),
    wroteSomething: () => wrote,
  };
}

/** Drives `accept` on a PENDING application sitting on a listing in one status. */
function applicationsService(status: ListingStatus) {
  const listing = aListing(status);
  let wrote = false;

  const application = {
    id: "app-1",
    listingId: listing.id,
    // Someone else's application: the owner accepting it is the normal case.
    applicantId: "profile-someone-else",
    status: "PENDING",
    decisionSource: null,
    message: null,
    rejectionReason: null,
    withdrawnReason: null,
    viewedAt: null,
    respondedAt: null,
    createdAt: new Date("2026-08-20T08:00:00.000Z"),
    updatedAt: new Date("2026-08-20T08:00:00.000Z"),
  };

  const transactionClient = {
    profile: { findUnique: async () => OWNER },
    replacementListing: {
      findUnique: async () => listing,
      // `accept` fills the listing, so it writes here as well as on the
      // application. Without this the fixture fails with a TypeError on a
      // status the guard was supposed to let through — which reads as a
      // broken guard rather than a broken test.
      update: async () => {
        wrote = true;
        return listing;
      },
    },
    application: {
      findUnique: async () => application,
      update: async () => {
        wrote = true;
        return application;
      },
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
  };

  const prisma = {
    profile: { findUnique: async () => OWNER },
    $transaction: async (
      operation: (tx: typeof transactionClient) => unknown,
    ) => operation(transactionClient),
  } as unknown as PrismaService;

  const config = { get: () => undefined } as unknown as ConfigService;

  return {
    service: new ApplicationsService(prisma, config),
    wroteSomething: () => wrote,
  };
}

/**
 * Runs one guard and reports whether the request got through.
 *
 * A 404 is rethrown rather than read as a refusal: it means the fixture never
 * reached the guard at all, which is a broken test that would otherwise pass
 * for the wrong reason — the same failure mode that let the original bug ship.
 */
async function passes(run: () => Promise<unknown>): Promise<Decision> {
  try {
    await run();
    return "allowed";
  } catch (error) {
    if (error instanceof NotFoundException) {
      throw error;
    }
    if (error instanceof BadRequestException) {
      return "refused";
    }
    throw error;
  }
}

describe("listing status guards", () => {
  it("classifies every status in the enum, with no gaps", () => {
    // The mechanism this file exists for. `satisfies` above already fails the
    // build on a missing or extra key, so this is the runtime statement of the
    // same intent: add a member to the `ListingStatus` enum and this fails
    // until every guard's row for it is written down.
    for (const guard of Object.values(GUARDS)) {
      expect(Object.keys(guard).sort()).toEqual([...ALL_STATUSES].sort());
    }
  });

  it("keeps `update` and `accept` in agreement on every reachable status", () => {
    // The invariant that was broken. Two guards asking the same question must
    // not answer it differently, whichever way the table is written.
    //
    // `DRAFT` is excluded, and only because it is unreachable for `accept`: a
    // draft holds no applications, so there is nothing to accept on one. Every
    // status a listing can actually carry an application in is checked.
    for (const status of ALL_STATUSES.filter((s) => s !== "DRAFT")) {
      expect(GUARDS.accept[status]).toBe(GUARDS.update[status]);
    }
  });

  describe("PATCH /replacement-listings/:id", () => {
    it.each(ALL_STATUSES)("%s", async (status) => {
      const { service, wroteSomething } = listingsService(status);
      const actual = await passes(() =>
        service.update("listing-1", OWNER.userId, { maxApplications: 7 }),
      );

      expect(actual).toBe(GUARDS.update[status]);
      expect(wroteSomething()).toBe(GUARDS.update[status] === "allowed");
    });
  });

  describe("PATCH /replacement-listings/:id/close", () => {
    it.each(ALL_STATUSES)("%s", async (status) => {
      const { service, wroteSomething } = listingsService(status);
      const actual = await passes(() =>
        service.close("listing-1", OWNER.userId),
      );

      expect(actual).toBe(GUARDS.close[status]);
      expect(wroteSomething()).toBe(GUARDS.close[status] === "allowed");
    });
  });

  describe("PATCH /replacement-listings/:id/cancel", () => {
    it.each(ALL_STATUSES)("%s", async (status) => {
      const { service, wroteSomething } = listingsService(status);
      const actual = await passes(() =>
        service.cancel("listing-1", OWNER.userId),
      );

      expect(actual).toBe(GUARDS.cancel[status]);
      expect(wroteSomething()).toBe(GUARDS.cancel[status] === "allowed");
    });
  });

  describe("PATCH /applications/:id/accept", () => {
    it.each(ALL_STATUSES)("%s", async (status) => {
      const { service, wroteSomething } = applicationsService(status);
      const actual = await passes(() => service.accept("app-1", OWNER.userId));

      expect(actual).toBe(GUARDS.accept[status]);
      expect(wroteSomething()).toBe(GUARDS.accept[status] === "allowed");
    });
  });

  it("refuses every guard on a listing closed without a retained candidate", () => {
    // The regression this file was written for, named so a future reader who
    // breaks it again finds the history and not just the table. It happened
    // once: `update` refused FILLED, CLOSED and CANCELLED but not this one, so
    // the owner could rewrite the title and dates of a posting they had just
    // closed. `accept` had the same gap, masked by an unrelated guard.
    expect(GUARDS.update.CLOSED_NO_CANDIDATE).toBe("refused");
    expect(GUARDS.accept.CLOSED_NO_CANDIDATE).toBe("refused");
    expect(GUARDS.close.CLOSED_NO_CANDIDATE).toBe("refused");
    expect(GUARDS.cancel.CLOSED_NO_CANDIDATE).toBe("refused");
  });
});
