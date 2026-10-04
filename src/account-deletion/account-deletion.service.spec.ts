import { describe, expect, it } from "bun:test";
import {
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import {
  LEGACY_PLATFORM_REJECTION_REASONS,
  REASON_ANOTHER_CANDIDATE_SELECTED,
  REASON_CANDIDATE_UNAVAILABLE,
  REASON_LISTING_CLOSED,
  REASON_LISTING_ERASED,
} from "../applications/rejection-reasons";

import type { PrismaService } from "../prisma.service";
import { AccountDeletionService } from "./account-deletion.service";

const pepper = "p".repeat(32);

type Scenario = {
  token?: { value: string; expiresAt: Date } | null;
  user?: { id: string; email: string; deletedAt: Date | null } | null;
  activeThirdPartyApplications?: number;
  pendingAuditRows?: number;
  /** Empty string models a misconfigured deployment with no key at all. */
  pepper?: string;
  /** Active applications the person holds on other people's listings. */
  activeApplicationsElsewhere?: {
    listingId: string;
  }[] /** Applications where the person had been accepted. */;
  acceptedPlacements?: { id: string; listingId: string }[];
  /** Listing statuses, keyed by id, as the recalculation reads them. */
  listings?: Record<
    string,
    { status: string; maxApplications?: number | null }
  >;
  /** Active application count per listing id. */
  activeCountPerListing?: Record<string, number>;
  /** Ids of the listings owned by the account being erased. */
  ownedListings?: string[];
  /** Applications other candidates filed on those listings. */
  thirdPartyCandidates?: {
    id: string;
    listingId: string;
    applicantId: string;
    status: string;
    rejectionReason?: string | null;
  }[];
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const listingUpdates: { id: string }[] = [];
  const applicationUpdates: { id: string }[] = [];
  const verificationDeletes: { where: unknown }[] = [];
  /** Ghost listings created to carry the third-party applications away. */
  const ghosts: Record<string, unknown>[] = [];

  const tx = {
    verification: {
      findFirst: async () => {
        calls.push("verification.findFirst");
        return scenario.token === undefined ? liveToken : scenario.token;
      },
      deleteMany: async (args: { where: unknown }) => {
        calls.push("verification.deleteMany");
        verificationDeletes.push(args);
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
      findMany: async () => {
        calls.push("replacementListing.findMany");
        return (scenario.ownedListings ?? []).map((id) => ({ id }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("replacementListing.create");
        ghosts.push(data);
        return { id: `ghost-${ghosts.length}` };
      },
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
        where: {
          applicantId?: string;
          status?: unknown;
          listingId?: string;
        };
        select?: { listingId?: boolean; id?: boolean };
      }) => {
        calls.push("application.findMany");
        if (where.status === "ACCEPTED") {
          return scenario.acceptedPlacements ?? [];
        }
        // The detachment pass, per listing. The service asks for
        // `applicantId: { not: "profile-1" }`; the fake has to apply that
        // negation itself, otherwise it would hand back the owner's own row too
        // and the test would pass for the wrong reason.
        if (select?.id && where.listingId) {
          return (scenario.thirdPartyCandidates ?? []).filter(
            (row) =>
              row.listingId === where.listingId &&
              row.applicantId !== "profile-1",
          );
        }
        if (select?.rejectionReason) {
          return (scenario.thirdPartyCandidates ?? []).filter(
            (row) => row.listingId === where.listingId,
          ) as { rejectionReason?: string | null }[];
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

        // `updateMany` is filtered by the caller, and the fake has to honour
        // the filter for the ordering assertions to mean anything: the scrub
        // is scoped to the account's own listings, and once a row has been
        // detached onto a ghost it must be out of reach. Blindly reporting
        // success would have let the scrub pass while reaching nothing.
        if (where.listing) {
          const owned = (scenario.ownedListings ?? []).length > 0;
          if (!owned) {
            return { count: 0 };
          }
        }

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
    get: (key: string) =>
      key === "deletionPepper" ? (scenario.pepper ?? pepper) : undefined,
  } as unknown as ConfigService;

  return {
    service: new AccountDeletionService(prisma, config),
    calls,
    updates,
    listingUpdates,
    applicationUpdates,
    verificationDeletes,
    ghosts,
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
      // The practice's free text goes first, while the rows are still on this
      // account's listings and the scrub's `listing: listingFilter` predicate
      // can still reach them.
      "application.updateMany",
      // Then the third-party applications are detached, while those listings
      // are still the rows they point at.
      "replacementListing.findMany",
      "profile.update",
      "practice.updateMany",
      "replacementListing.updateMany",
      // Read first: the listings to recompute are collected before the flip.
      "application.findMany",
      "application.updateMany",
      // And again for the accepted placements, if any.
      "application.updateMany",
      "application.findMany",
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

  it("tags each failure with a code the client can branch on", async () => {
    const cases = [
      {
        scenario: { token: null },
        type: NotFoundException,
        code: undefined,
      },
      {
        scenario: { token: expiredToken, user: pendingUser },
        type: GoneException,
        code: "TOKEN_EXPIRED",
      },
      {
        scenario: {
          token: liveToken,
          user: { ...pendingUser, deletedAt: new Date() },
        },
        type: GoneException,
        code: "ALREADY_ERASED",
      },
      {
        scenario: { token: liveToken, user: pendingUser, pendingAuditRows: 0 },
        type: ConflictException,
        code: "NO_PENDING_REQUEST",
      },
    ];

    for (const { scenario, type, code } of cases) {
      const { service } = makeService({
        token: liveToken,
        user: pendingUser,
        ...scenario,
      });

      const error = await service
        .confirmDeletion("abc")
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      // The code is the only way the client can tell these apart: 410 covers an
      // expired link and an already-erased account, 409 covers the listings
      // blocker and a missing audit row.
      if (code) {
        expect(
          (error as { getResponse: () => { code?: string } }).getResponse(),
        ).toMatchObject({ code });
      }
    }
  });

  it("clears every single-use link the account still holds", async () => {
    const { service, verificationDeletes } = makeService({
      token: liveToken,
      user: pendingUser,
    });

    await service.confirmDeletion("abc");

    // Token consumption first, then the purge. Both identifiers better-auth
    // writes must be matched, by prefix, against the user id in `value`. The
    // shapes here are literals this file chose; the prefixes are better-auth's,
    // so the suite that proves they still match real rows is
    // `confirm-deletion.e2e.test.ts`.
    expect(verificationDeletes).toHaveLength(2);
    expect(verificationDeletes[1]).toMatchObject({
      where: {
        value: "user-1",
        OR: [
          { identifier: { startsWith: "delete-account-" } },
          { identifier: { startsWith: "reset-password:" } },
        ],
      },
    });
  });

  it("refuses to run without a pepper instead of writing unkeyed hashes", async () => {
    const { service, calls } = makeService({
      token: liveToken,
      user: pendingUser,
      pepper: "",
    });

    // An empty key still yields a well-formed HMAC, which is a plain digest
    // over a lowercased email and reversible with a dictionary.
    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(calls).not.toContain("user.update");
  });

  it("refuses a pepper too short to key the trail with", async () => {
    // Rejected in the env schema too, but the schema is not the only caller:
    // `deletionHash` takes whatever key it is handed, and a one-character pepper
    // produces exactly the dictionary-reversible digest this exists to prevent.
    const { service, calls } = makeService({
      token: liveToken,
      user: pendingUser,
      pepper: "a",
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(calls).not.toContain("user.update");
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

  it("moves a third party's accepted application off the listing before it dies", async () => {
    const { service, ghosts, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "application-accepted",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "ACCEPTED",
        },
      ],
    });

    await service.confirmDeletion("abc");

    // `Application.listingId` cascades, so an accepted application left on the
    // erased account's listing dies with it — the candidate's message and the
    // practice's decision, neither of which they asked to lose.
    const moved = (updates.applications as Record<string, unknown>[]).find(
      (update) => update.listingId !== undefined,
    );
    expect(moved).toBeDefined();

    // One ghost per original listing, so a candidate who applied to three of the
    // account's listings keeps three distinct `(listingId, applicantId)` pairs
    // and cannot trip the unique index.
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({
      status: "CLOSED",
      urgent: false,
      title: "Annonce retirée",
      description: null,
    });
  });

  it("detaches before the listings are rewritten, while they are still the referenced rows", async () => {
    const { service, calls, ghosts } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "application-accepted",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "ACCEPTED",
        },
      ],
    });

    await service.confirmDeletion("abc");

    // The ordering is invisible in the types and is the whole correctness of
    // this: once the listings are CANCELLED and overwritten there is nothing
    // left to copy, and the applications no longer point at a listing we own.
    expect(calls.indexOf("replacementListing.create")).toBeLessThan(
      calls.indexOf("replacementListing.updateMany"),
    );
    expect(ghosts).toHaveLength(1);
  });

  it("creates no ghost listing for a listing only the owner applied to", async () => {
    const { service, ghosts } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "application-own",
          listingId: "listing-1",
          applicantId: "profile-1",
          status: "ACCEPTED",
        },
      ],
    });

    await service.confirmDeletion("abc");

    // The owner's own rows are theirs to lose, and a ghost per listing would
    // leave empty containers behind forever.
    expect(ghosts).toEqual([]);
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
      (update) =>
        update.rejectionReason === null && update.message === undefined,
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

    // Selected by content, not by position: the writes happen in an order the
    // erasure depends on, and indexing them would make any reordering read as
    // a regression even when nothing changed.
    expect(
      applications.find((update) => update.status === "WITHDRAWN"),
    ).toBeDefined();
    expect(
      applications.find(
        (update) => update.message === null && update.withdrawnReason === null,
      ),
    ).toBeDefined();
    expect(
      applications.find(
        (update) =>
          update.rejectionReason === null &&
          update.message === undefined &&
          update.status === undefined,
      ),
    ).toBeDefined();
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

  it("lets a filled listing through: the third-party application is detached, not lost", async () => {
    // The regression this whole pass exists for. A `FILLED` listing always
    // carries an `ACCEPTED` third-party row, and the guard counted that as a
    // reason to refuse the erasure — which meant the detachment, living inside
    // `anonymize` and therefore after the guard, could never run. A practice
    // holding a placed replacement had no way to erase their account at all,
    // and the advice the 409 gave ("close your listings") could not help: a
    // closed listing is not a filled one.
    const { service, ghosts } = makeService({
      token: liveToken,
      user: pendingUser,
      // What the guard sees on a filled listing: the ACCEPTED row plus the
      // PENDING/SHORTLISTED ones `accept` did not clear.
      activeThirdPartyApplications: 4,
      ownedListings: ["listing-filled"],
      thirdPartyCandidates: [
        {
          id: "application-accepted",
          listingId: "listing-filled",
          applicantId: "profile-2",
          status: "ACCEPTED",
        },
      ],
    });

    await service.confirmDeletion("abc");

    expect(ghosts).toHaveLength(1);
  });

  it("settles the applications it preserves, the way closing a listing does", async () => {
    // Preserving the row is not enough. A candidate left on `PENDING` reads
    // "waiting for a decision" on their dashboard, and one left on `ACCEPTED`
    // reads "you have a replacement to turn up for" — for a practice that no
    // longer exists and a posting that is gone. `close` and `cancel` already
    // settle their applications for the same reason.
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-pending",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "PENDING",
        },
        {
          id: "a-shortlisted",
          listingId: "listing-1",
          applicantId: "profile-3",
          status: "SHORTLISTED",
        },
        {
          id: "a-accepted",
          listingId: "listing-1",
          applicantId: "profile-4",
          status: "ACCEPTED",
        },
      ],
    });

    await service.confirmDeletion("abc");

    const settled = (updates.applications as Record<string, unknown>[]).find(
      (update) =>
        update.status === "REJECTED" && update.rejectionReason !== undefined,
    );
    expect(settled).toMatchObject({
      status: "REJECTED",
      rejectionReason: "L'annonce n'existe plus, le cabinet a fermé son compte",
    });
    // All three at once, before the move, so the ghost is the only thing they
    // ever sit on.
    const settledIds = (settled?.where as { id: { in: string[] } }).id.in;
    expect(settledIds).toEqual(["a-pending", "a-shortlisted", "a-accepted"]);
  });

  it("scrubs the practice's free text on a row it still preserves", async () => {
    // The regression that motivated the ordering below.
    //
    // The scrub is scoped to `listing: listingFilter` — the account's own
    // listings. Detaching first moves the rows onto ghost listings whose
    // `createdById` is the system profile, so the scrub's predicate stops
    // matching them entirely. The candidate then keeps a rejection reason
    // written by a practice that no longer exists, readable forever.
    //
    // Nothing about the row being preserved excuses this: preserving the
    // candidate's message and timestamps is the point, but a practice's prose
    // about a candidate is the practice's own free text, and it is exactly what
    // this scrub exists to erase.
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-rejected",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "REJECTED",
          rejectionReason: "Texte libre ecrit par le cabinet",
        },
      ],
    });

    await service.confirmDeletion("abc");

    // The real proof is the order: the scrub must be issued while the rows are
    // still on the account's listings. Checking the `where` clause alone would
    // pass whatever the order, because the predicate is identical either way —
    // only the moment the rows moved differs.
    const applications = updates.applications ?? [];
    const scrubIndex = applications.findIndex(
      (update) =>
        update.rejectionReason === null && update.status === undefined,
    );
    // The detach is the update that carries a `listingId`.
    const detachIndex = applications.findIndex(
      (update) => update.listingId !== undefined,
    );

    expect(scrubIndex).toBeGreaterThanOrEqual(0);
    expect(detachIndex === -1 || scrubIndex < detachIndex).toBe(true);
  });

  it("still writes the platform reason after the scrub has run", async () => {
    // Order matters in both directions. Scrub first, so the practice's prose
    // goes; detach second, so `REASON_LISTING_ERASED` — ours, not theirs —
    // lands on the row afterwards and is not scrubbed away with it.
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-pending",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "PENDING",
        },
      ],
    });

    await service.confirmDeletion("abc");

    const applications = updates.applications as Record<string, unknown>[];
    const withOurReason = applications.findIndex(
      (update) => update.rejectionReason === REASON_LISTING_ERASED,
    );
    const scrub = applications.findIndex(
      (update) =>
        update.rejectionReason === null && update.status === undefined,
    );

    expect(withOurReason).toBeGreaterThanOrEqual(0);
    // The scrub is written first; the platform reason lands on the settled row
    // after it and therefore survives.
    expect(scrub === -1 || scrub < withOurReason).toBe(true);
  });

  it("never leaves a preserved row with a status the candidate cannot explain", async () => {
    // The case the platform-reason list alone does not cover. A row that was
    // already `REJECTED` carrying the practice's prose is preserved, the prose
    // is erased, and the status stays `REJECTED` — so the frontend falls back
    // to « Aucun motif n'a été communiqué par le cabinet ». That is false: no
    // cabinet decided anything, the account is gone.
    //
    // The truth is the listing is gone, which is exactly what
    // `REASON_LISTING_ERASED` says. It goes on every preserved row, on top of
    // whatever reason survived, so the banner always explains the state the
    // candidate is actually in.
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-free-text",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "REJECTED",
          rejectionReason: "Texte libre ecrit par le cabinet",
        },
      ],
    });

    await service.confirmDeletion("abc");

    const stamped = (updates.applications ?? []).find(
      (update) => update.rejectionReason === REASON_LISTING_ERASED,
    ) as { where: { id: { in: string[] } } } | undefined;

    // The already-rejected row is included, not skipped as "already decided".
    expect(stamped?.where.id.in).toContain("a-free-text");
  });

  it("keeps a reachable platform reason on a preserved row and clears the practice's prose", async () => {
    // Both halves of the same predicate. A reason the platform wrote describes
    // what happened to the listing; a practice's free text is the practice's
    // own and goes with the account. Clearing the first as well would leave the
    // candidate reading « Rejetée » with the frontend's fallback — « Aucun
    // motif n'a été communiqué par le cabinet » — which is false, because no
    // cabinet ever decided anything.
    //
    // `REASON_LISTING_CLOSED` is absent from the assertions below on purpose:
    // `close` settles the applications before the status flips, so it cannot
    // still be sitting on a row the erasure preserves. Listing it as protected
    // would claim a guarantee no row can rely on — see `PLATFORM_REJECTION_REASONS`.
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-platform",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "REJECTED",
          rejectionReason: REASON_ANOTHER_CANDIDATE_SELECTED,
        },
        {
          id: "a-free-text",
          listingId: "listing-1",
          applicantId: "profile-3",
          status: "REJECTED",
          rejectionReason: "Texte libre ecrit par le cabinet",
        },
      ],
    });

    await service.confirmDeletion("abc");

    const scrub = (updates.applications ?? []).find(
      (update) =>
        update.rejectionReason === null && update.status === undefined,
    ) as { where: { rejectionReason: { notIn: string[] } } } | undefined;

    expect(scrub).toBeDefined();
    expect(scrub?.where.rejectionReason.notIn).toContain(
      REASON_ANOTHER_CANDIDATE_SELECTED,
    );
    expect(scrub?.where.rejectionReason.notIn).toContain(REASON_LISTING_ERASED);
    // The legacy spelling too, or a pre-translation row would be erased as if
    // a practice had written it.
    expect(scrub?.where.rejectionReason.notIn).toContain(
      "Another candidate was selected for this listing",
    );
    // Exactly the reachable set — no more, or the practice's own prose would
    // start surviving.
    expect(scrub?.where.rejectionReason.notIn).not.toContain(
      REASON_LISTING_CLOSED,
    );
  });

  it("settles a rejected row but never touches a withdrawal", async () => {
    const { service, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-rejected",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "REJECTED",
        },
        {
          id: "a-withdrawn",
          listingId: "listing-1",
          applicantId: "profile-3",
          status: "WITHDRAWN",
        },
        {
          id: "a-pending",
          listingId: "listing-1",
          applicantId: "profile-4",
          status: "PENDING",
        },
      ],
    });

    await service.confirmDeletion("abc");

    const settle = (updates.applications ?? []).find(
      (update) => update.rejectionReason === REASON_LISTING_ERASED,
    ) as { where: { id: { in: string[] } } } | undefined;

    // The withdrawal is left out: a candidate who pulled out did so
    // themselves, and the listing being gone afterwards does not change the
    // account of that. The already-rejected row is settled instead, because its
    // free text is about to be scrubbed and the status must stay explicable.
    expect(settle?.where.id.in).toContain("a-rejected");
    expect(settle?.where.id.in).toContain("a-pending");
    expect(settle?.where.id.in).not.toContain("a-withdrawn");
    const move = (updates.applications ?? []).find(
      (update) => update.listingId !== undefined,
    ) as { where: { id: { in: string[] } } } | undefined;
    expect(move?.where.id.in).toEqual([
      "a-rejected",
      "a-withdrawn",
      "a-pending",
    ]);
  });

  it("preserves a third-party application whatever its status", async () => {
    // A `REJECTED` row still holds the candidate's message and the practice's
    // decision, and both belong to someone who never asked to be erased.
    const { service, ghosts, updates } = makeService({
      token: liveToken,
      user: pendingUser,
      ownedListings: ["listing-1"],
      thirdPartyCandidates: [
        {
          id: "a-rejected",
          listingId: "listing-1",
          applicantId: "profile-2",
          status: "REJECTED",
        },
        {
          id: "a-withdrawn",
          listingId: "listing-1",
          applicantId: "profile-3",
          status: "WITHDRAWN",
        },
      ],
    });

    await service.confirmDeletion("abc");

    expect(ghosts).toHaveLength(1);
    const moved = (updates.applications as Record<string, unknown>[]).find(
      (update) => update.listingId !== undefined,
    );
    // One ghost, both settled rows on it — so the unique
    // `(listingId, applicantId)` index cannot be tripped either.
    expect((moved?.where as { id: { in: string[] } }).id.in).toEqual([
      "a-rejected",
      "a-withdrawn",
    ]);
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
      get: (key: string) =>
        key === "deletionPepper" ? (scenario.pepper ?? pepper) : undefined,
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
        // The practice is the one shown this, and it has to be able to say so
        // without reading the reason: the candidate erased their account, which
        // is not a judgement of anyone.
        decisionSource: "CANDIDATE_UNAVAILABLE",
        rejectionReason: REASON_CANDIDATE_UNAVAILABLE,
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
        // Every spelling: rows written before the reasons were translated
        // still carry the English one, and rows written before they were
        // reworded carry the older French one. Those candidates must come back
        // too — an auto-rejection is not a decision the practice took, so
        // leaving it out would strand them in REJECTED forever.
        rejectionReason: {
          in: [
            REASON_ANOTHER_CANDIDATE_SELECTED,
            ...LEGACY_PLATFORM_REJECTION_REASONS,
          ],
        },
      },
      status: "PENDING",
      // Back in the pipeline: no decision stands any more, so the column
      // returns to null exactly as a fresh application leaves it.
      decisionSource: null,
      rejectionReason: null,
      respondedAt: null,
    });

    expect(listingUpdates).toEqual([
      { id: "listing-7", status: "IN_DISCUSSION" },
    ]);
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
