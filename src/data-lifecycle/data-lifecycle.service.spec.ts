import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import {
  ACCOUNT_PURGE_GRACE_DAYS,
  DataLifecycleService,
  PURGE_BATCH_SIZE,
} from "./data-lifecycle.service";

type Call = { model: string; where: unknown; limit?: number };

function makePrisma(
  options: {
    counts?: Record<string, number>;
    failOn?: string;
    lockHeld?: boolean;
    orphans?: { id: string }[];
  } = {},
) {
  const calls: Call[] = [];
  const deletedLists: string[][] = [];

  const client = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("pg_try_advisory_lock")) {
        return [{ locked: !options.lockHeld }];
      }
      return options.orphans ?? [];
    },
    $executeRaw: async () => 0,
    session: {
      deleteMany: async (args: { where: unknown; limit?: number }) => {
        if (options.failOn === "session") throw new Error("boom");
        calls.push({ model: "session", ...args });
        return { count: options.counts?.session ?? 0 };
      },
    },
    verification: {
      deleteMany: async (args: { where: unknown; limit?: number }) => {
        if (options.failOn === "verification") throw new Error("boom");
        calls.push({ model: "verification", ...args });
        return { count: options.counts?.verification ?? 0 };
      },
    },
    user: {
      deleteMany: async (args: { where: unknown; limit?: number }) => {
        if (options.failOn === "user") throw new Error("boom");
        calls.push({ model: "user", ...args });
        return { count: options.counts?.user ?? 0 };
      },
    },
    dataDeletionRequest: {
      deleteMany: async (args: { where: unknown; limit?: number }) => {
        if (options.failOn === "trail") throw new Error("boom");
        calls.push({ model: "dataDeletionRequest", ...args });
        return { count: options.counts?.trail ?? 0 };
      },
    },
    replacementListing: {
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        deletedLists.push(args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
  };

  return { prisma: client as unknown as PrismaService, calls, deletedLists };
}

describe("DataLifecycleService retention sweep", () => {
  it("purges sessions, verifications, anonymized accounts and the trail", async () => {
    const { prisma, calls } = makePrisma({ counts: { session: 3, user: 1 } });

    await new DataLifecycleService(prisma).purgeExpired();

    expect(calls.map((call) => call.model)).toEqual([
      "session",
      "verification",
      "user",
      "dataDeletionRequest",
    ]);
  });

  it("deletes anonymized accounts only after the grace period", async () => {
    const { prisma, calls } = makePrisma();
    const before = Date.now();

    await new DataLifecycleService(prisma).purgeExpired();

    const where = calls[2].where as { deletedAt: { lte: Date } };
    const cutoff = where.deletedAt.lte.getTime();
    expect(cutoff).toBeLessThanOrEqual(before);
    expect(cutoff).toBeGreaterThan(
      before - (ACCOUNT_PURGE_GRACE_DAYS + 1) * 86_400_000,
    );
  });

  it("bounds every delete so a backlog cannot become one long transaction", async () => {
    const { prisma, calls } = makePrisma();

    await new DataLifecycleService(prisma).purgeExpired();

    for (const call of calls) {
      expect(call.limit).toBe(PURGE_BATCH_SIZE);
    }
  });

  it("keeps batching while a statement fills its batch", async () => {
    let sessionCalls = 0;
    const { prisma } = makePrisma();
    const counting = {
      ...prisma,
      session: {
        deleteMany: async (args: { where: unknown; limit?: number }) => {
          sessionCalls += 1;
          return { count: sessionCalls < 3 ? PURGE_BATCH_SIZE : 1 };
        },
      },
    } as unknown as PrismaService;

    await new DataLifecycleService(counting).purgeExpired();

    expect(sessionCalls).toBe(3);
  });

  it("returns immediately when another replica holds the lock", async () => {
    const { prisma, calls } = makePrisma({ lockHeld: true });

    await new DataLifecycleService(prisma).purgeExpired();

    expect(calls).toHaveLength(0);
  });

  it("never throws when one table fails", async () => {
    const { prisma, calls } = makePrisma({ failOn: "session" });

    await expect(
      new DataLifecycleService(prisma).purgeExpired(),
    ).resolves.toBeUndefined();

    // The rest of the sweep still ran.
    expect(calls.map((call) => call.model)).not.toContain("session");
    expect(calls.map((call) => call.model)).toContain("verification");
  });
});

describe("DataLifecycleService ghost listings", () => {
  it("collects the ghosts no application points at", async () => {
    const { prisma, deletedLists } = makePrisma({
      orphans: [{ id: "ghost-1" }, { id: "ghost-2" }],
    });

    const collected = await new DataLifecycleService(
      prisma,
    ).collectOrphanGhostListings();

    expect(collected).toBe(2);
    expect(deletedLists).toEqual([["ghost-1", "ghost-2"]]);
  });

  it("deletes nothing when every ghost still holds an application", async () => {
    const { prisma, deletedLists } = makePrisma({ orphans: [] });

    const collected = await new DataLifecycleService(
      prisma,
    ).collectOrphanGhostListings();

    expect(collected).toBe(0);
    expect(deletedLists).toHaveLength(0);
  });
});
