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
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];

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
    },
    application: {
      count: async () => scenario.activeThirdPartyApplications ?? 0,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("application.updateMany");
        (updates.applications ??= []).push(data);
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
      "application.updateMany",
      "application.updateMany",
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
});
