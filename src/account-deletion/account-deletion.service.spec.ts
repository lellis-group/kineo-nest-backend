import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GoneException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma.service";
import { AccountDeletionService } from "./account-deletion.service";
import { ANONYMIZED_LISTING_TITLE } from "./anonymize";

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
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const writes: Record<string, unknown> = {};

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
    replacementListing: {
      findMany: async () => scenario.listings ?? [],
      updateMany: async (args: unknown) => {
        calls.push("replacementListing.updateMany");
        writes.listings = args;
        return { count: (scenario.listings ?? []).length };
      },
    },
    application: {
      updateMany: async (args: unknown) => {
        calls.push("application.updateMany");
        writes.applications = args;
        return { count: 1 };
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
    dataDeletionRequest: {
      updateMany: async (args: unknown) => {
        calls.push("dataDeletionRequest.updateMany");
        writes.trail = args;
        return { count: 1 };
      },
    },
  };

  const prisma = {
    $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) =>
      run(tx),
  } as unknown as PrismaService;

  return { service: new AccountDeletionService(prisma), calls, writes };
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

  it("scrubs the profile and takes the listings out of circulation", async () => {
    const { service, writes } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "OPEN" }],
    });

    const result = await service.confirmDeletion("abc");

    expect(writes.profile).toMatchObject({
      data: {
        rppsNumber: null,
        city: null,
        latitude: null,
        longitude: null,
        isPublic: false,
      },
    });
    const listingWrite = writes.listings as {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    };
    expect(listingWrite.data.title).toBe(ANONYMIZED_LISTING_TITLE);
    expect(listingWrite.data.status).toBe("CLOSED_NO_CANDIDATE");
    expect(result.anonymizedListings).toBe(1);
  });

  it("leaves a listing that holds an accepted placement alone", async () => {
    const { service, writes, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
      profile: { id: "profile-1", userId: "user-1" },
      listings: [{ id: "listing-1", status: "FILLED" }],
    });

    const result = await service.confirmDeletion("abc");

    expect(calls).not.toContain("replacementListing.updateMany");
    expect(result.protectedPlacements).toBe(1);
    expect(result.anonymizedListings).toBe(0);
    expect(writes.user).toBeDefined();
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
    expect(writes.verificationWhere).toMatchObject({
      where: {
        OR: expect.arrayContaining([{ identifier: "user@example.com" }]),
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
      data: { status: "EXECUTED", executedAt: expect.any(Date) },
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

  it("refuses to erase anything without a pepper", async () => {
    delete process.env.DELETION_PEPPER;

    const { service, calls } = makeService({
      verification: LIVE_TOKEN,
      user: { id: "user-1", email: "user@example.com" },
    });

    await expect(service.confirmDeletion("abc")).rejects.toThrow(
      "DELETION_PEPPER is required",
    );
    expect(calls).toHaveLength(0);
  });
});
