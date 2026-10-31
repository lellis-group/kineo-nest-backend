import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import type { PrismaService } from "../prisma.service";
import { AccountDeletionService } from "./account-deletion.service";
import { ANONYMIZED_DESCRIPTION, ANONYMIZED_LISTING_TITLE } from "./anonymize";

const PEPPER = "e".repeat(64);

type Scenario = {
  verification?: {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
  } | null;
  user?: {
    id: string;
    email: string;
    deletedAt?: Date | null;
  } | null;
  profile?: { id: string; userId: string } | null;
  listings?: { id: string; status: string }[];
  applications?: { id: string; status: string }[];
  thirdPartyApplications?: { id: string; listingId: string; status: string }[];
  ownApplications?: { id: string; listingId: string; status: string }[];
  /** Listings other accounts own, which the post-settle recount reads. */
  externalListings?: {
    id: string;
    status: string;
    maxApplications: number | null;
  }[];
  /** Active applications the recount counts on the listing it reads. */
  externalActiveCount?: number;
  scaffoldMissing?: boolean;
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const writes: Record<string, unknown> & {
    listingWrites?: unknown[];
    applicationWrites?: unknown[];
  } = {};

  const tx = {
    verification: {
      findFirst: async () => scenario.verification ?? null,
      delete: async () => {
        calls.push("verification.delete");
        return {};
      },
      deleteMany: async (args: unknown) => {
        calls.push("verification.deleteMany");
        writes.verificationWhere = args;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => scenario.user ?? null,
      update: async (args: unknown) => {
        calls.push("user.update");
        writes.user = args;
        return {};
      },
    },
    profile: {
      findUnique: async () => scenario.profile ?? null,
      update: async (args: unknown) => {
        calls.push("profile.update");
        writes.profile = args;
        return {};
      },
    },
    // The scaffold the third-party applications are parked on.
    practice: {
      findUnique: async () =>
        scenario.scaffoldMissing ? null : { id: SYSTEM_SCAFFOLD.practiceId },
      updateMany: async (args: unknown) => {
        calls.push("practice.updateMany");
        writes.practices = args;
        return { count: 1 };
      },
    },
    replacementListing: {
      // What `recalcListingStatus` reads, after the settle. Only listings other
      // accounts own reach it: the account's own ones were rewritten above.
      findUnique: async (args: { where: { id: string } }) =>
        scenario.externalListings?.find(
          (listing) => listing.id === args.where.id,
        ) ?? null,
      // The ghost the third-party applications are parked on.
      upsert: async (args: unknown) => {
        calls.push("replacementListing.upsert");
        writes.ghostUpsert = args;
        return { id: "ghost-for-listing-1" };
      },
      findMany: async () => scenario.listings ?? [],
      updateMany: async (args: unknown) => {
        calls.push("replacementListing.updateMany");
        const record = structuredClone(args) as {
          where: { id: { in: string[] } };
        };
        (writes.listingWrites ??= []).push(record);
        return { count: record.where.id.in.length };
      },
      update: async (args: unknown) => {
        calls.push("replacementListing.update");
        writes.recount = args;
        return {};
      },
    },
    application: {
      findMany: async (args: { where: { applicantId: unknown } }) => {
        calls.push("application.findMany");
        // The account's own active applications are queried by applicant id;
        // the third-party ones by `applicantId: { not: ownerProfileId }`.
        if (typeof args.where.applicantId === "string") {
          writes.settledWhere = args;
          return scenario.ownApplications ?? [];
        }
        writes.detachedWhere = args;
        return scenario.thirdPartyApplications ?? [];
      },
      updateMany: async (args: unknown) => {
        calls.push("application.updateMany");
        (writes.applicationWrites ??= []).push(structuredClone(args));
        return { count: 1 };
      },
      count: async () => scenario.externalActiveCount ?? 0,
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
    dataDeletionRequest: {
      updateMany: async (args: unknown) => {
        calls.push("dataDeletionRequest.updateMany");
        writes.trail = args;
        // Zero means no pending request matched this confirmation, which the
        // service has to treat as a refusal rather than an erasure with no proof.
        return { count: scenario.scaffoldMissing ? 0 : 1 };
      },
    },
  };

  let transactionOptions: unknown;
  const prisma = {
    $transaction: async (
      run: (transaction: typeof tx) => Promise<unknown>,
      options?: unknown,
    ) => {
      transactionOptions = options;
      return run(tx);
    },
  } as unknown as PrismaService;

  return {
    service: new AccountDeletionService(prisma),
    calls,
    writes,
    // Exposed so a test can assert how the erasure transaction is configured —
    // this fake used to swallow the options, which is why nothing noticed the
    // erasure running without the shared helper's retry and `maxWait`.
    transactionOptions: () => transactionOptions,
  };
}

const LIVE_TOKEN = {
  id: "verification-1",
  identifier: "delete-account-abc",
  value: "user-1",
  expiresAt: new Date(Date.now() + 60_000),
};

beforeEach(() => {
  process.env.DELETION_PEPPER = PEPPER;
});

afterEach(() => {
  delete process.env.DELETION_PEPPER;
});

describe("AccountDeletionService", () => {
  it("anonymizes the account instead of deleting the row", async () => {
    const { service, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
      applications: [{ id: "application-1", status: "PENDING" }],
    });

    const result = await service.confirmDeletion("abc");

    const userWrite = writes.user as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(userWrite.where).toEqual({ id: "user-1" });
    expect(userWrite.data.email).toMatch(
      /^erased-[0-9a-f]{32}@deleted\.invalid$/,
    );
    expect(userWrite.data.email).not.toContain("user@example.com");
    expect(userWrite.data.name).toBeNull();
    expect(userWrite.data.emailVerified).toBe(false);
    expect(userWrite.data.deletedAt).toBeInstanceOf(Date);
    expect(result.anonymizedAt).toEqual(expect.any(String));
  });

  it("scrubs the practices the profile owned", async () => {
    // The one thing an erasure used to walk past. `user`, `profile`,
    // `replacementListing` and `application` were all scrubbed while a practice
    // kept its real name, its real address and its coordinates, and stayed
    // `isPublic` — still listed, still in the geographic index, for the whole
    // grace window, pointing at a profile whose fields were all null.
    const { service, writes, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
    });

    await service.confirmDeletion("abc");

    expect(calls).toContain("practice.updateMany");

    // Copied before any assertion: `toMatchObject` with `expect.any` leaves its
    // matchers in the object it matched, and this fake hands over a reference to
    // the arguments it recorded.
    const write = structuredClone(writes.practices) as {
      where: { ownerId: string };
      data: Record<string, string | number | boolean | null>;
    };

    expect(write.where).toEqual({ ownerId: "profile-1" });
    expect(write.data.isPublic).toBe(false);

    // Coordinates cleared, never moved to zero: a `lat`/`lng` of 0/0 is a real
    // place in the Atlantic, and an indexed practice there is worse than one that
    // has left the geo query's `latitude IS NOT NULL` branch.
    expect(write.data.latitude).toBeNull();
    expect(write.data.longitude).toBeNull();

    // `name` is not nullable, so it takes a placeholder rather than null — and
    // that placeholder has to say nothing and identify nobody.
    for (const field of ["name", "address", "city"]) {
      const value = write.data[field];
      expect(typeof value).toBe("string");
      expect(String(value)).not.toBe("");
      expect(String(value).toLowerCase()).not.toContain("practice");
      expect(String(value).toLowerCase()).not.toContain("cabinet");
      expect(String(value).toLowerCase()).not.toContain("dr");
    }
  });

  it("scrubs the profile and takes the listings out of circulation", async () => {
    const { service, writes, transactionOptions } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
    });

    const result = await service.confirmDeletion("abc");

    // The erasure is the one write that must not half-happen, and it is the one
    // that now goes through the shared serializable helper like every other.
    expect(transactionOptions()).toMatchObject({
      isolationLevel: "Serializable",
    });

    expect(writes.profile).toMatchObject({
      data: {
        rppsNumber: null,
        city: null,
        latitude: null,
        longitude: null,
        isPublic: false,
      },
    });
    const listingWrite = (
      writes.listingWrites as {
        where: { id: { in: string[] } };
        data: Record<string, unknown>;
      }[]
    )[0] as {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    };
    expect(listingWrite.where).toEqual({ id: { in: ["listing-1"] } });
    expect(listingWrite.data.title).toBe(ANONYMIZED_LISTING_TITLE);
    expect(listingWrite.data.status).toBe("CLOSED_NO_CANDIDATE");
    expect(result.anonymizedListings).toBe(1);
  });

  it("recounts the listing an application the account withdrew frees", async () => {
    // The recount is what `settledApplications` has always described: a FULL
    // listing whose freed slot rests on this account's withdrawn application
    // stays FULL forever without it, refusing every candidate although a place
    // re-opened.
    const { service, writes, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      ownApplications: [
        { id: "application-1", listingId: "listing-target", status: "PENDING" },
      ],
      externalListings: [
        { id: "listing-target", status: "FULL", maxApplications: 2 },
      ],
      // One candidate still holds the other slot, so the freed one leaves the
      // listing IN_DISCUSSION rather than OPEN.
      externalActiveCount: 1,
    });

    const result = await service.confirmDeletion("abc");

    expect(result.settledApplications).toBe(1);

    const recount = writes.recount as {
      where: { id: string };
      data: { status: string };
    };
    expect(recount.where.id).toBe("listing-target");
    expect(recount.data.status).toBe("IN_DISCUSSION");

    // Inside the transaction, the recount comes after the settle, so it counts
    // the applications the settling left behind — not the ones it removed.
    expect(calls.indexOf("application.updateMany")).toBeLessThan(
      calls.indexOf("replacementListing.update"),
    );
  });

  it("recounts a listing whose last application it withdrew back to OPEN", async () => {
    const { service, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      ownApplications: [
        {
          id: "application-1",
          listingId: "listing-target",
          status: "SHORTLISTED",
        },
      ],
      externalListings: [
        { id: "listing-target", status: "FULL", maxApplications: 1 },
      ],
      externalActiveCount: 0,
    });

    await service.confirmDeletion("abc");

    const recount = writes.recount as {
      where: { id: string };
      data: { status: string };
    };
    expect(recount.data.status).toBe("OPEN");
  });

  it("recounts each freed listing once, however many applications it settled", async () => {
    // A candidate who held the last slot on two listings gets both recounts,
    // but no listing is recounted twice: the read dedupes the ids.
    const { service, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      ownApplications: [
        { id: "application-1", listingId: "listing-a", status: "PENDING" },
        { id: "application-2", listingId: "listing-a", status: "SHORTLISTED" },
        { id: "application-3", listingId: "listing-b", status: "PENDING" },
      ],
      externalListings: [
        { id: "listing-a", status: "FULL", maxApplications: 2 },
        { id: "listing-b", status: "IN_DISCUSSION", maxApplications: null },
      ],
      externalActiveCount: 0,
    });

    await service.confirmDeletion("abc");

    const recountCalls = calls.filter(
      (call) => call === "replacementListing.update",
    );
    expect(recountCalls).toHaveLength(2);
  });

  it("refuses to erase when no pending request matches, and erases nothing", async () => {
    // The trail row is the accountability trail (art. 5(2)). Anonymizing an
    // account without one is the outcome that trail exists to prevent, and the
    // count was ignored — so a rotated pepper, a swept row or a forged link all
    // produced a completed erasure with no record of it.
    const { service, calls, writes } = makeService({
      scaffoldMissing: true,
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Nothing was rewritten: not the user, not the profile, not the listings.
    expect(calls).not.toContain("user.update");
    expect(calls).not.toContain("profile.update");
    expect(calls).not.toContain("replacementListing.updateMany");
    expect(writes.user).toBeUndefined();
    expect(writes.profile).toBeUndefined();
    expect(writes.listingWrites).toBeUndefined();
  });

  it("leaves a listing that holds an accepted placement alone", async () => {
    const { service, writes, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "FILLED" }],
      thirdPartyApplications: [
        { id: "application-9", listingId: "listing-1", status: "ACCEPTED" },
      ],
    });

    const result = await service.confirmDeletion("abc");

    // The placement stays where it was agreed: ghosting it would leave the
    // candidate waiting with no real listing to point at, and no practicing
    // owner will ever settle it anyway.
    expect(calls).not.toContain("replacementListing.upsert");
    expect(result.protectedPlacements).toBe(1);
    expect(result.anonymizedListings).toBe(0);
    expect(writes.user).toBeDefined();

    // What the protected listing loses is the erased person's words, and
    // nothing else: the dates, the status and the placement stay readable to
    // the candidate who holds it.
    const [content] = (writes.listingWrites ?? []) as {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    }[];
    expect(content.where).toEqual({ id: { in: ["listing-1"] } });
    expect(content.data.title).toBe(ANONYMIZED_LISTING_TITLE);
    expect(content.data.description).toBe(ANONYMIZED_DESCRIPTION);
    expect(content.data).not.toHaveProperty("status");
    expect(content.data).not.toHaveProperty("startDate");
  });

  it("settles an application parked on a ghost that nobody can ever decide", async () => {
    // `REJECTED` and `WITHDRAWN` rows are destroyed with the rest; the moved
    // ones keep their thread. But a `PENDING` one the owner would have decided
    // is waiting on a decision that can never land: the account that would make
    // it is gone, and it holds a slot in the candidate's own application quota.
    const { service, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
      thirdPartyApplications: [
        { id: "application-1", listingId: "listing-1", status: "PENDING" },
        { id: "application-2", listingId: "listing-1", status: "ACCEPTED" },
      ],
    });

    const result = await service.confirmDeletion("abc");

    expect(result.detachedApplications).toBe(2);

    const writes_ = writes.applicationWrites as {
      where: {
        id?: { in: string[] };
        status?: { in: string[] };
        listingId?: { in: string[] };
      };
      data: Record<string, unknown>;
    }[];

    // The move first, then the settle. The settle reaches both moved rows —
    // it is the *status* half of its where clause that keeps `ACCEPTED` out,
    // because an accepted placement is not a question left unanswered.
    const move = writes_[0];
    expect(move.data).toMatchObject({ listingId: "ghost-for-listing-1" });
    const settle = writes_[1];
    expect(settle.where.id).toEqual({
      in: ["application-1", "application-2"],
    });
    expect(settle.where.status).toEqual({ in: ["PENDING", "SHORTLISTED"] });
    expect(settle.data.status).toBe("REJECTED");
    expect(settle.data.decisionSource).toBe("SYSTEM");
    expect(settle.data.respondedAt).toBeInstanceOf(Date);
  });

  it("keeps the status a CANCELLED or CLOSED listing was closed with", async () => {
    const { service, writes, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [
        { id: "listing-1", status: "CANCELLED" },
        { id: "listing-2", status: "CLOSED" },
      ],
    });

    const result = await service.confirmDeletion("abc");

    expect(result.anonymizedListings).toBe(0);

    // One scrub of the owner's words over both rows, and no second write that
    // would have replaced the status with CLOSED_NO_CANDIDATE: "cancelled by
    // the owner" is a fact the trail keeps.
    const contentWrites = (writes.listingWrites ?? []) as {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    }[];
    expect(calls).toContain("replacementListing.updateMany");
    expect(contentWrites).toHaveLength(1);
    expect(contentWrites[0].where).toEqual({
      id: { in: ["listing-1", "listing-2"] },
    });
    expect(contentWrites[0].data).not.toHaveProperty("status");
    expect(contentWrites[0].data).not.toHaveProperty("startDate");
  });

  it("ends the sessions and the credentials, and purges the tokens", async () => {
    const { service, calls, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
    });

    await service.confirmDeletion("abc");

    expect(calls).toContain("session.deleteMany");
    expect(calls).toContain("account.deleteMany");
    expect(calls).toContain("verification.deleteMany");
    expect(writes.verificationWhere).toEqual({
      where: {
        OR: [
          { identifier: "user@example.com" },
          {
            AND: [
              { identifier: { startsWith: "delete-account-" } },
              { value: "user-1" },
            ],
          },
        ],
      },
    });
  });

  it("marks the trail executed, keyed by the fingerprint rather than the id", async () => {
    const { service, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
    });

    await service.confirmDeletion("abc");

    expect(writes.trail).toMatchObject({
      data: { status: "ANONYMIZED", executedAt: expect.any(Date) },
    });
    const where = (writes.trail as { where: { userIdHash: string } }).where;
    expect(where.userIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(where).not.toHaveProperty("userId");
  });

  it("rejects an unknown or already used token with 404", async () => {
    const { service } = makeService({ verification: null });

    await expect(service.confirmDeletion("unknown")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects an expired token with 410 and consumes it", async () => {
    const { service, calls } = makeService({
      verification: {
        ...LIVE_TOKEN,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(calls).toContain("verification.delete");
  });

  it("rejects with 410 when the account is gone or already anonymized", async () => {
    const missing = makeService({ verification: LIVE_TOKEN, user: null });
    await expect(missing.service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      GoneException,
    );

    const alreadyAnonymized = makeService({
      verification: LIVE_TOKEN,
      user: {
        id: "user-1",
        email: "erased-abc@deleted.invalid",
        deletedAt: new Date(),
      },
    });
    await expect(
      alreadyAnonymized.service.confirmDeletion("abc"),
    ).rejects.toBeInstanceOf(GoneException);
    expect(alreadyAnonymized.calls).not.toContain("user.update");
  });

  it("trims the token before looking it up", async () => {
    const { service } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
    });

    await expect(service.confirmDeletion("  abc  ")).resolves.toMatchObject({
      anonymizedAt: expect.any(String),
    });
  });

  it("refuses to erase anything without a pepper, as a 503, not a 500", async () => {
    // The controller documents a 503 for a missing pepper: a plain `Error` used
    // to reach the global filter as a 500, which a hardened environment rewrites
    // into "Internal server error" — a body that names neither the cause nor
    // the fact that the caller's inputs are fine.
    delete process.env.DELETION_PEPPER;

    const { service, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.confirmDeletion("abc")).rejects.toThrow(
      "DELETION_PEPPER is required",
    );
    expect(calls).toHaveLength(0);
  });
});
