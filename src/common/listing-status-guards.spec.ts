/**
 * One table of truth for what every listing guard does, per status.
 *
 * `listing-status.spec.ts` pins the predicates. This pins the *services*: every
 * guard is driven for every status, so a status nobody classified is a gap rather
 * than a silence.
 *
 * Two real bugs lived in that gap. `close` accepted only `OPEN` and `FILLED`, so a
 * posting that had shortlisted candidates — `IN_DISCUSSION` or `FULL` — could not
 * be closed, and `cancel` was the only way out, telling every one of those
 * candidates the posting was abandoned rather than closed. `cancel` did not
 * refuse `FILLED` either, so a filled posting could be cancelled with a placement
 * still attached to it.
 *
 * The table inverts the failure. The decision for every (action, status) pair is
 * written down once, in full, next to the enum, and a status nobody classified is
 * a type error rather than a gap. Each row is driven through the real service and
 * checked twice over: that the request is refused, *and* that nothing was
 * written — a guard that let a refused request through to the database would
 * still be a bug.
 */
import { describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { ListingStatus } from "../generated/prisma/enums";
import type { PrismaService } from "../prisma.service";
import { ReplacementlistingsService } from "../replacementlistings/replacementlistings.service";

const ALL_STATUSES = Object.values(ListingStatus);

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
 * Drives the listings service with one listing in one status.
 *
 * Only the reads the guards perform are implemented. Every write flips a flag
 * rather than returning a value, because the assertion that matters is not "did it
 * succeed" but "did it touch a row at all".
 */
function listingsService(status: ListingStatus) {
  const listing = aListing(status);
  let wrote = false;

  const transactionClient = {
    profile: { findUnique: async () => OWNER },
    replacementListing: {
      findUnique: async () => listing,
      findUniqueOrThrow: async () => ({
        ...listing,
        _count: { applications: 0 },
      }),
      update: async () => {
        wrote = true;
        return { ...listing, _count: { applications: 0 } };
      },
      findFirst: async () => null,
      count: async () => 0,
      delete: async () => {
        wrote = true;
        return listing;
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

  // `close` and `remove` read the listing outside the transaction, through
  // `assertOwnership`, so the outer client needs the same reads. Only `cancel` and
  // the applications service go through `$transaction`.
  const reads = {
    profile: { findUnique: async () => OWNER },
    replacementListing: {
      findUnique: async () => listing,
      count: async () => 0,
      // `close` and `remove` write outside the transaction; the flag is what the
      // "nothing was written" half of a refusal asserts.
      update: async () => {
        wrote = true;
        return { ...listing, _count: { applications: 0 } };
      },
      delete: async () => {
        wrote = true;
        return listing;
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

  // Whether this run went through `$transaction`, and therefore whether its reads
  // and its writes shared a connection.
  let transactions = 0;

  const prisma = {
    ...reads,
    $transaction: async (
      operation: (tx: typeof transactionClient) => unknown,
    ) => {
      transactions += 1;
      return operation(transactionClient);
    },
  } as unknown as PrismaService;

  const config = { get: () => undefined } as unknown as ConfigService;

  return {
    service: new ReplacementlistingsService(prisma, config),
    wroteSomething: () => wrote,
    transactions: () => transactions,
  };
}

/** Read as: "from this status, does this action get through?" */
const TABLE = {
  close: {
    DRAFT: "refused",
    OPEN: "allowed",
    // A posting with shortlisted candidates on it. Closing it is the ordinary way
    // to end one nobody was picked for, and it used to be impossible.
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    // Closed out with a placement on it.
    FILLED: "allowed",
    CLOSED: "refused",
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
  cancel: {
    DRAFT: "allowed",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    // The placement on it was agreed with a candidate: cancelling would leave them
    // holding a replacement on a posting that no longer exists.
    FILLED: "refused",
    CLOSED: "refused",
    CLOSED_NO_CANDIDATE: "refused",
    CANCELLED: "refused",
  },
  remove: {
    DRAFT: "allowed",
    OPEN: "allowed",
    IN_DISCUSSION: "allowed",
    FULL: "allowed",
    FILLED: "refused",
    CLOSED: "allowed",
    CLOSED_NO_CANDIDATE: "allowed",
    CANCELLED: "allowed",
  },
} as const satisfies Record<
  string,
  Record<ListingStatus, "allowed" | "refused">
>;

/** The four entry points the table covers, all on the same service. */
const ACTIONS = {
  close: (service: ReplacementlistingsService) =>
    service.close("listing-1", OWNER.userId),
  cancel: (service: ReplacementlistingsService) =>
    service.cancel("listing-1", OWNER.userId),
  remove: (service: ReplacementlistingsService) =>
    service.remove("listing-1", OWNER.userId),
} as const;

describe("listing guards, over every status", () => {
  it("classifies every status of the enum, in every column", () => {
    // Without this a row could quietly drop a status and the table would look
    // complete. `satisfies` pins the type; this pins the data.
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(ACTIONS).sort());
    for (const row of Object.values(TABLE)) {
      expect(Object.keys(row).sort()).toEqual([...ALL_STATUSES].sort());
    }
  });

  for (const [action, row] of Object.entries(TABLE)) {
    const call = ACTIONS[action as keyof typeof ACTIONS];

    for (const status of ALL_STATUSES) {
      it(`${action} from ${status}: ${row[status]}`, async () => {
        const { service, wroteSomething } = listingsService(status);

        if (row[status] === "refused") {
          // Refused…
          await expect(call(service)).rejects.toThrow();
          // …and nothing written on the way to refusing.
          expect(wroteSomething()).toBe(false);
          return;
        }

        await call(service);
        expect(wroteSomething()).toBe(true);
      });
    }
  }
});

describe("deletes are atomic", () => {
  /**
   * The reason this file also records *how* each action runs.
   *
   * `remove` used to read the listing, count the third-party applications and
   * delete, on three separate connections. An application committed in the gap was
   * not seen by the count and went with the cascade — which is precisely the harm
   * the guard exists to prevent, and nothing in the sequential test could see it.
   *
   * So: the delete and its guard have to share a transaction, and this is what
   * says so.
   */
  it("remove runs its guard and its delete inside one transaction", async () => {
    const { service, transactions } = listingsService(ListingStatus.OPEN);

    await service.remove("listing-1", OWNER.userId);

    expect(transactions()).toBe(1);
  });

  it("remove refuses without having deleted anything", async () => {
    const { service, wroteSomething, transactions } = listingsService(
      ListingStatus.FILLED,
    );

    await expect(service.remove("listing-1", OWNER.userId)).rejects.toThrow();
    expect(wroteSomething()).toBe(false);
    expect(transactions()).toBe(1);
  });
});
