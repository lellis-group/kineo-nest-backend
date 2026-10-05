import { describe, expect, it } from "bun:test";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import type { Prisma } from "../generated/prisma/client";
import {
  detachThirdPartyApplications,
  PRESERVED_APPLICATION_STATUSES,
  ServiceUnavailableScaffoldError,
} from "./ghost-listing";

/**
 * A client that answers per listing, so the per-listing write is exercised.
 *
 * `applications` is keyed by the listing the row currently sits on, which is what
 * a second call sees: the rows have moved by then.
 */
function makePrisma(options: {
  scaffold?: boolean;
  applicationsByListing?: Record<string, { id: string; applicantId: string }[]>;
  ghostIds?: string[];
}) {
  const writes: {
    findManyWhere: Prisma.ApplicationWhereInput[];
    upserts: { id: string }[];
    moves: { to: string; ids: string[] }[];
  } = { findManyWhere: [], upserts: [], moves: [] };

  // The ghost each listing's rows have already been moved to, if any.
  const moved = new Map<string, string>();

  const client = {
    practice: {
      findUnique: async () =>
        options.scaffold === false ? null : { id: SYSTEM_SCAFFOLD.practiceId },
    },
    application: {
      findMany: async (args: unknown) => {
        const where = (args as { where: Prisma.ApplicationWhereInput }).where;
        const listingId = where.listingId as string;
        writes.findManyWhere.push(where);
        // A copy, because the fake below splices the row out of that array to
        // simulate the move — and the caller still holds what it was given, which
        // a real query result never shares.
        return [...(options.applicationsByListing?.[listingId] ?? [])];
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as {
          where: { id: { in: string[] } };
          data: { listingId: string };
        };
        writes.moves.push({
          to: data.listingId,
          ids: where.id.in,
        });
        for (const id of where.id.in) {
          for (const [listing, rows] of Object.entries(
            options.applicationsByListing ?? {},
          )) {
            const row = rows.find((candidate) => candidate.id === id);
            if (row) {
              options.applicationsByListing?.[listing].splice(
                rows.indexOf(row),
                1,
              );
            }
          }
        }
        moved.set(data.listingId, data.listingId);
        return { count: where.id.in.length };
      },
    },
    replacementListing: {
      upsert: async (args: unknown) => {
        const { where } = args as {
          where: { id: string };
          create: { id: string };
          update: Record<string, never>;
        };
        writes.upserts.push(where);
        return { id: options.ghostIds?.length ? where.id : where.id };
      },
      create: async () => {
        throw new Error(
          "a ghost must be upserted on a derived id, not created blind",
        );
      },
      findFirst: async () => null,
    },
  };

  return { client: client as never, writes };
}

const input = {
  ownerProfileId: "profile-owner",
  listingIds: ["listing-1", "listing-2"],
};

describe("detachThirdPartyApplications", () => {
  it("parks each candidate's applications on a ghost of the listing they were on", async () => {
    const { client, writes } = makePrisma({
      applicationsByListing: {
        "listing-1": [{ id: "application-1", applicantId: "profile-c1" }],
        "listing-2": [{ id: "application-2", applicantId: "profile-c2" }],
      },
    });

    const result = await detachThirdPartyApplications(client, input);

    expect(result.detachedApplications).toBe(2);

    // Two destinations, not one: `application` carries
    // `@@unique([listingId, applicantId])`, so one ghost for the whole account
    // would put the same candidate's two rows on the same pair and be rejected
    // with P2002, rolling the entire erasure back — forever, for that account.
    expect(writes.moves).toEqual([
      { to: "ghost-for-listing-1", ids: ["application-1"] },
      { to: "ghost-for-listing-2", ids: ["application-2"] },
    ]);
    expect(result.ghostListingIds).toEqual([
      "ghost-for-listing-1",
      "ghost-for-listing-2",
    ]);
  });

  it("never takes the erased account's own applications", async () => {
    const { client, writes } = makePrisma({
      applicationsByListing: {
        "listing-1": [{ id: "application-1", applicantId: "profile-c1" }],
      },
    });

    await detachThirdPartyApplications(client, input);

    // Asked once per listing, in order.
    expect(writes.findManyWhere.map((where) => where.listingId)).toEqual([
      "listing-1",
      "listing-2",
    ]);
    for (const where of writes.findManyWhere) {
      expect(where.applicantId).toEqual({ not: "profile-owner" });
      expect(where.status).toEqual({ in: [...PRESERVED_APPLICATION_STATUSES] });
    }
  });

  it("creates the ghost on the scaffold's practice, closed to applicants", async () => {
    const { client, writes } = makePrisma({
      applicationsByListing: {
        "listing-1": [{ id: "application-1", applicantId: "profile-c1" }],
      },
    });

    await detachThirdPartyApplications(client, input);

    expect(writes.upserts).toEqual([{ id: "ghost-for-listing-1" }]);
  });

  it("reuses the ghost it already made on a second run", async () => {
    // The id is a function of the listing, so a retried erasure upserts the same
    // row instead of accumulating one ghost per attempt.
    const { client, writes } = makePrisma({
      applicationsByListing: {
        "listing-1": [{ id: "application-1", applicantId: "profile-c1" }],
      },
    });

    await detachThirdPartyApplications(client, input);
    // The rows are on the ghost now, so the original listing holds nothing.
    await detachThirdPartyApplications(client, input);

    expect(writes.upserts).toEqual([{ id: "ghost-for-listing-1" }]);
  });

  it("creates nothing when there is no third-party application", async () => {
    const { client, writes } = makePrisma({ applicationsByListing: {} });

    const result = await detachThirdPartyApplications(client, input);

    expect(result).toEqual({ ghostListingIds: [], detachedApplications: 0 });
    expect(writes.upserts).toEqual([]);
    expect(writes.moves).toEqual([]);
  });

  it("refuses rather than destroying the applications when the scaffold is missing", async () => {
    const { client } = makePrisma({
      scaffold: false,
      applicationsByListing: {
        "listing-1": [{ id: "application-1", applicantId: "profile-c1" }],
      },
    });

    await expect(
      detachThirdPartyApplications(client, input),
    ).rejects.toBeInstanceOf(ServiceUnavailableScaffoldError);
  });
});
