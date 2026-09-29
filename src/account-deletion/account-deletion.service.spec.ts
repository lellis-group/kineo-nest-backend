import { describe, expect, it } from "bun:test";
import {
  ConflictException,
  GoneException,
  NotFoundException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma.service";
import { AccountDeletionService } from "./account-deletion.service";

const pepper = "p".repeat(32);

type Scenario = {
  token?: { value: string; expiresAt: Date } | null;
  user?: { id: string; email: string; deletedAt: Date | null } | null;
  activeThirdPartyApplications?: number;
  pendingAuditRows?: number;
  /** Active applications the person holds on other people's listings. */
  activeApplicationsElsewhere?: { listingId: string }[];
  /** Applications where the person had been accepted. */
  acceptedPlacements?: { id: string; listingId: string }[];
  /** Listing statuses, keyed by id, as the recalculation reads them. */
  listings?: Record<
    string,
    { status: string; maxApplications?: number | null }
  >;
  /** Active application count per listing id. */
  activeCountPerListing?: Record<string, number>;
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const listingUpdates: { id: string }[] = [];
  const applicationUpdates: { id: string }[] = [];

  const tx = {
    verification: {
      findFirst: async () => {
        calls.push("verification.findFirst");
        return scenario.token === undefined ? liveToken : scenario.token;
      },
      deleteMany: async () => {
        calls.push("verification.deleteMany");
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => {
        calls.push("user.findUnique");
        return scenario.user ?? null;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("user.update");
        updates.user = data;
        return {};
      },
    },
    profile: {
      findUnique: async () => ({ id: "profile-1" }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("profile.update");
        updates.profile = data;
        return {};
      },
    },
    practice: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("practice.updateMany");
        updates.practice = data;
        return { count: 1 };
      },
    },
    replacementListing: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("replacementListing.updateMany");
        updates.listing = data;
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push("replacementListing.findUnique");
        return scenario.listings?.[where.id] ?? null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        calls.push("replacementListing.update");
        listingUpdates.push({ id: where.id, ...data });
        return {};
      },
    },
    application: {
      count: async ({ where }: { where?: { listingId?: string } } = {}) => {
        if (where?.listingId && scenario.activeCountPerListing) {
          return scenario.activeCountPerListing[where.listingId] ?? 0;
        }
        return scenario.activeThirdPartyApplications ?? 0;
      },
      findMany: async ({
        where,
        select,
      }: {
        where: { applicantId?: string; status?: unknown };
        select?: { listingId?: boolean };
      }) => {
        calls.push("application.findMany");
        if (where.status === "ACCEPTED") {
          return scenario.acceptedPlacements ?? [];
        }
        return select?.listingId
          ? (scenario.activeApplicationsElsewhere ?? []).map((row) => ({
              listingId: row.listingId,
            }))
          : (scenario.activeApplicationsElsewhere ?? []);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        calls.push("application.update");
        applicationUpdates.push({ id: where.id, ...data });
        return {};
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        calls.push("application.updateMany");
        (updates.applications ??= []).push({ where, ...data });
        return { count: 1 };
      },
    },
    dataDeletionRequest: {
      updateMany: async () => {
        calls.push("dataDeletionRequest.updateMany");
        return { count: scenario.pendingAuditRows ?? 1 };
      },
    },
    session: {
      deleteMany: async () => {
        calls.push("session.deleteMany");
        return { count: 2 };
      },
    },
    account: {
      deleteMany: async () => {
        calls.push("account.deleteMany");
        return { count: 1 };
      },
    },
  };

  const prisma = {
    $transaction: async (
      fn: (client: typeof tx) => Promise<unknown>,
      _options?: unknown,
    ) => fn(tx),
  } as unknown as PrismaService;

  const config = {
    get: (key: string) => (key === "deletionPepper" ? pepper : undefined),
  } as unknown as ConfigService;

  return {
    service: new AccountDeletionService(prisma, config),
    calls,
    updates,
    listingUpdates,
    applicationUpdates,
  };
}

const pendingUser = {
  id: "user-1",
  email: "claire.martin@example.com",
  deletedAt: null,
};

const liveToken = {
  value: "user-1",
  expiresAt: new Date(Date.now() + 3_600_000),
};

const expiredToken = {
  value: "user-1",
  expiresAt: new Date(Date.now() - 1_000),
};

describe("AccountDeletionService", () => {
  it("anonymizes the account instead of deleting it", async () => {
    const { service, calls, updates } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    expect(calls).toEqual([
      "verification.findFirst",
      "verification.deleteMany",
      "user.findUnique",
      "dataDeletionRequest.updateMany",
      "user.update",
      "profile.update",
      "practice.updateMany",
      "replacementListing.updateMany",
      // Read first: the listings to recompute are collected before the flip.
      "application.findMany",
      "application.updateMany",
      "application.updateMany",
      // And again for the accepted placements, if any.
      "application.findMany",
      "application.updateMany",
      "session.deleteMany",
      "account.deleteMany",
      "verification.deleteMany",
    ]);
    expect(updates.user).toMatchObject({
      name: null,
      image: null,
      emailVerified: false,
    });
    expect(updates.user?.email).toMatch(
      /^deleted\+[0-9a-f]{16}@deleted\.invalid$/,
    );
    expect(updates.user?.email).not.toContain("claire.martin");
  });

  it("revokes access so the account cannot be used again", async () => {
    const { service, calls } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    expect(calls).toContain("session.deleteMany");
    expect(calls).toContain("account.deleteMany");
  });

  it("redacts the personal profile and the published content", async () => {
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    expect(updates.profile).toMatchObject({
      rppsNumber: null,
      city: null,
      latitude: null,
      longitude: null,
      isPublic: false,
      verified: false,
    });
    expect(updates.practice).toMatchObject({ isPublic: false, latitude: null });
    expect(updates.listing).toMatchObject({ description: null });
  });

  it("takes the published listings out of circulation", async () => {
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    // An OPEN listing keeps showing up in the public search and keeps
    // accepting candidates, and the purge would cascade away any application
    // created in between. Terminal, so `recalcListingStatus` will not reopen.
    expect(updates.listing).toMatchObject({ status: "CANCELLED" });
  });

  it("nulls the rejection reason a practice wrote about the person", async () => {
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    // Sent applications: the text was authored by the practice, and the
    // practice could read it back through `findMine` for the whole grace
    // period. The reverse direction has its own scrub.
    const sent = updates.applications?.find(
      (update) => update.message === null && update.withdrawnReason === null,
    );
    expect(sent).toMatchObject({ rejectionReason: null });

    // Received applications: the reason the person wrote is removed there too.
    const received = updates.applications?.find(
      (update) => update.rejectionReason === null && update.message === undefined,
    );
    expect(received).toBeDefined();
  });

  it("redacts the free text the account holder wrote on both sides", async () => {
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    const applications = updates.applications as Record<string, unknown>[];

    expect(applications[0]).toMatchObject({ status: "WITHDRAWN" });
    expect(applications[1]).toMatchObject({
      message: null,
      withdrawnReason: null,
    });
    expect(applications[2]).toMatchObject({ rejectionReason: null });
  });

  it("rejects a second confirmation of the same link with 404", async () => {
    const { service, calls } = makeService({ token: null });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls).not.toContain("user.update");
  });

  it("rejects an expired link with 410", async () => {
    const { service, calls } = makeService({ token: expiredToken });

    expect(calls).not.toContain("user.update");

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it("rejects a link pointing at an already anonymized account with 410", async () => {
    const { service } = makeService({
      token: liveToken,
      user: { ...pendingUser, deletedAt: new Date() },
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it("refuses the erasure while other candidates hold active applications", async () => {
    const { service, calls } = makeService({
      token: liveToken,
      user: pendingUser,
      activeThirdPartyApplications: 3,
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(calls).not.toContain("user.update");
  });

  it("rolls back when no pending erasure request matches the confirmation", async () => {
    const { service, calls } = makeService({
      token: liveToken,
      user: pendingUser,
      pendingAuditRows: 0,
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(calls).not.toContain("user.update");
  });

  it("trims the token before looking it up", async () => {
    const looked: unknown[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          verification: {
            findFirst: async (args: unknown) => {
              looked.push(args);
              return null;
            },
          },
        }),
    } as unknown as PrismaService;
    const config = {
      get: (key: string) => (key === "deletionPepper" ? pepper : undefined),
    } as unknown as ConfigService;

    await expect(
      new AccountDeletionService(prisma, config).confirmDeletion("  abc  "),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(looked[0]).toMatchObject({
      where: { identifier: "delete-account-abc" },
    });
  });

  it("reopens a listing that only looked full because of the person", async () => {
    const { service, listingUpdates } = makeService({
      token: liveToken,
      user: pendingUser,
      activeApplicationsElsewhere: [{ listingId: "listing-42" }],
      listings: { "listing-42": { status: "FULL" } },
      // The withdrawn application was the only active one left.
      activeCountPerListing: { "listing-42": 0 },
    });

    await service.confirmDeletion("abc");

    // Left in FULL, the listing stays hidden from findAll (which filters on
    // OPEN) and refuses new candidates, with nothing telling the owner why.
    expect(listingUpdates).toEqual([{ id: "listing-42", status: "OPEN" }]);
  });

  it("keeps a listing at capacity when other candidates remain", async () => {
    const { service, listingUpdates } = makeService({
      token: liveToken,
      user: pendingUser,
      activeApplicationsElsewhere: [{ listingId: "listing-42" }],
      listings: { "listing-42": { status: "FULL", maxApplications: 2 } },
      activeCountPerListing: { "listing-42": 2 },
    });

    await service.confirmDeletion("abc");

    expect(listingUpdates).toEqual([]);
  });

  it("reopens a filled listing and restores the candidates it had auto-rejected", async () => {
    const { service, updates, listingUpdates, applicationUpdates } =
      makeService({
        token: liveToken,
        user: pendingUser,
        acceptedPlacements: [{ id: "app-accepted", listingId: "listing-7" }],
        listings: { "listing-7": { status: "FILLED" } },
        // The two candidates `accept` had turned down are the active set again.
        activeCountPerListing: { "listing-7": 2 },
      });

    await service.confirmDeletion("abc");

    // The accepted application is the one row demoted individually...
    expect(applicationUpdates).toEqual([
      {
        id: "app-accepted",
        status: "REJECTED",
        rejectionReason: "This candidate is no longer available",
        respondedAt: expect.any(Date),
      },
    ]);

    // ...and the auto-rejections go back to the pipeline, so the practice
    // finds the pool it started with instead of a FILLED listing with nobody
    // in it. Only the auto-written reason is targeted: a rejection a human
    // typed stays rejected.
    const restore = updates.applications?.find(
      (update) => update.status === "PENDING",
    );
    expect(restore).toMatchObject({
      where: {
        listingId: "listing-7",
        id: { not: "app-accepted" },
        status: "REJECTED",
        rejectionReason: "Another candidate was selected for this listing",
      },
      status: "PENDING",
      rejectionReason: null,
      respondedAt: null,
    });

    expect(listingUpdates).toEqual([{ id: "listing-7", status: "IN_DISCUSSION" }]);
  });

  it("never reopens a listing its owner closed or cancelled", async () => {
    for (const status of ["CLOSED", "CANCELLED"]) {
      const { service, listingUpdates } = makeService({
        token: liveToken,
        user: pendingUser,
        acceptedPlacements: [{ id: "app-accepted", listingId: "listing-7" }],
        listings: { "listing-7": { status } },
        activeCountPerListing: { "listing-7": 2 },
      });

      await service.confirmDeletion("abc");

      expect(listingUpdates).toEqual([]);
    }
  });
});
