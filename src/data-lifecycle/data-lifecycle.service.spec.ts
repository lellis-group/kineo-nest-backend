import { describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import { PrismaService } from "../prisma.service";
import { DataLifecycleService } from "./data-lifecycle.service";

const DAY = 86_400_000;

type Call = { model: string; op: "findMany" | "deleteMany"; where: unknown };

/**
 * One full batch on the first `findMany`, then nothing: the sweep reads ids,
 * deletes them, and stops when the table comes back empty. That is the shape the
 * assertions care about — the filter it selected rows with, and the ids it then
 * removed.
 */
function makePrisma() {
  const calls: Call[] = [];

  function table(model: string, ids: string[]) {
    let drained = false;

    return {
      findMany: async (args: { where: unknown }) => {
        calls.push({ model, op: "findMany", where: args.where });
        if (drained) {
          return [];
        }
        drained = true;
        return ids.map((id) => ({ id }));
      },
      deleteMany: async (args: { where: unknown }) => {
        calls.push({ model, op: "deleteMany", where: args.where });
        return { count: ids.length };
      },
    };
  }

  const prisma = {
    $queryRaw: async () => [{ locked: true }],
    session: table("session", ["s1"]),
    verification: table("verification", ["v1"]),
    dataDeletionRequest: table("dataDeletionRequest", ["d1"]),
    user: table("user", ["u1"]),
    replacementListing: {
      deleteMany: async (args: { where: unknown }) => {
        calls.push({
          model: "replacementListing",
          op: "deleteMany",
          where: args.where,
        });
        return { count: 0 };
      },
    },
  } as unknown as PrismaService;

  return { prisma, calls };
}

/** The filters the sweep selected rows with, one per model per sweep. */
function selectedFilters(
  calls: Call[],
  model: string,
): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.model === model && call.op === "findMany")
    .map((call) => call.where as Record<string, unknown>);
}

function config(values: Record<string, number>) {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function daysBack(cutoff: Date): number {
  return Math.round((Date.now() - cutoff.getTime()) / DAY);
}

describe("DataLifecycleService", () => {
  it("purges expired sessions and verification tokens", async () => {
    const { prisma, calls } = makePrisma();

    await new DataLifecycleService(prisma).purgeExpired();

    expect(calls[0]).toMatchObject({ model: "session", op: "findMany" });
    expect(calls[1]).toMatchObject({ model: "session", op: "deleteMany" });

    const [where] = selectedFilters(calls, "session");
    const { expiresAt } = where as { expiresAt?: { lt?: Date } };
    expect(expiresAt?.lt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("bounds the trail with two horizons anchored on the last state change", async () => {
    const { prisma, calls } = makePrisma();

    await new DataLifecycleService(prisma).purgeExpired();

    const requests = selectedFilters(calls, "dataDeletionRequest");
    expect(requests).toHaveLength(2);

    const [abandoned, executed] = requests.map((where) => {
      return where as { status: unknown; updatedAt: { lt: Date } };
    });

    expect(abandoned.status).toEqual({ in: ["PENDING", "SUPERSEDED"] });
    expect(executed.status).toBe("ANONYMIZED");

    // Anchored on updatedAt, so a request executed today still serves its full
    // year from today rather than from the day it was first asked for.
    for (const where of [abandoned, executed]) {
      expect(where.updatedAt.lt).toBeInstanceOf(Date);
    }
    expect(daysBack(executed.updatedAt.lt)).toBe(365);
    expect(daysBack(abandoned.updatedAt.lt)).toBe(30);
  });

  it("honours retention overrides from configuration", async () => {
    const { prisma, calls } = makePrisma();

    await new DataLifecycleService(
      prisma,
      config({
        dataDeletionRequestRetentionDays: 7,
        pendingDeletionRequestRetentionDays: 2,
      }),
    ).purgeExpired();

    const requests = selectedFilters(calls, "dataDeletionRequest").map(
      (where) => where as { updatedAt: { lt: Date } },
    );

    expect(daysBack(requests[0].updatedAt.lt)).toBe(2);
    expect(daysBack(requests[1].updatedAt.lt)).toBe(7);
  });

  it("never throws when the sweep fails", async () => {
    const prisma = {
      session: {
        deleteMany: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as PrismaService;

    await expect(
      new DataLifecycleService(prisma).purgeExpired(),
    ).resolves.toBeUndefined();
  });

  describe("purgeAnonymizedAccounts", () => {
    it("drops only the accounts anonymized before the grace period", async () => {
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      // Scoped to the user sweep: `purgeAnonymizedAccounts` also collects orphan
      // ghost listings, so the assertion is on which call this is rather than on
      // the only call made. Asserting a total here would make every new step of
      // this sweep a breaking change — and, when the ghost collection was first
      // added, it hid behind the sweep's own `try`/`catch` instead of failing
      // here at all.
      const [where] = selectedFilters(calls, "user");
      expect(where).toBeDefined();
      const { deletedAt } = where as { deletedAt: { lt: Date } };
      expect(daysBack(deletedAt.lt)).toBe(30);
    });

    it("honours the grace period override", async () => {
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(
        prisma,
        config({ accountPurgeGraceDays: 90 }),
      ).purgeAnonymizedAccounts();

      const [where] = selectedFilters(calls, "user");
      expect(
        daysBack((where as { deletedAt: { lt: Date } }).deletedAt.lt),
      ).toBe(90);
    });

    it("cannot reach the system scaffold that the ghost listings hang from", async () => {
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      // The scaffold is an ordinary user row with `deletedAt` NULL, and this is
      // the only filter. The ghost listings a candidate's surviving application
      // points at belong to that profile, so a sweep that ever stopped matching
      // on `deletedAt` — or a migration that stamped the row — would cascade
      // the applications away after the grace period and undo the detachment
      // silently. The assertion is on the shape of the filter, because the row
      // itself lives in the database.
      const [where] = selectedFilters(calls, "user");
      expect(Object.keys(where)).toEqual(["deletedAt"]);
      expect(
        (where as { deletedAt: { lt: Date } }).deletedAt.lt,
      ).toBeInstanceOf(Date);
    });

    it("never throws when the purge fails", async () => {
      const prisma = {
        user: {
          deleteMany: async () => {
            throw new Error("boom");
          },
        },
      } as unknown as PrismaService;

      await expect(
        new DataLifecycleService(prisma).purgeAnonymizedAccounts(),
      ).resolves.toBeUndefined();
    });
  });

  describe("orphan ghost listings", () => {
    /** The ghost-collection query, asserted on the shape of its filter. */
    function ghostWhere(calls: Call[]) {
      const call = calls.filter((c) => c.model === "replacementListing");
      expect(call.length).toBeGreaterThan(0);
      return call[0].where as unknown as {
        practiceId: string;
        applications: { none: Record<string, never> };
      };
    }

    it("collects a ghost that no application points at any more", async () => {
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      const where = ghostWhere(calls);
      expect(where.practiceId).toBe(SYSTEM_SCAFFOLD.practiceId);
      expect(where.applications).toEqual({ none: {} });
    });

    it("never collects a ghost that still carries an application", async () => {
      // The safety property, and the reason this is a subquery rather than an
      // age threshold. A ghost holding a row IS the context a candidate reads
      // on their dashboard; deleting it would cascade their message and their
      // decision away, silently undoing the detachment the erasure performed
      // when it created the ghost in the first place.
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      // `applications: { none: {} }` is the whole guarantee: the delete is only
      // issued against rows with zero applications, so a ghost with one is
      // excluded by the database and not by a hopeful read-then-delete in
      // application code.
      const where = ghostWhere(calls);
      expect(where.applications.none).toEqual({});
      expect(Object.keys(where)).toEqual(["practiceId", "applications"]);
    });

    it("scopes the collection to the system practice", async () => {
      // Without this, an ordinary practice whose owner erased every
      // application would have its listing deleted by a data-retention sweep.
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      expect(ghostWhere(calls).practiceId).toBe(SYSTEM_SCAFFOLD.practiceId);
    });

    it("collects ghosts only after the account cascade, never before", async () => {
      // Ordering is the mechanism, not a detail: the ghost is collectable only
      // once the application it carried is actually gone. Collected first, it
      // would delete the row out from under the cascade that was about to
      // remove it.
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      const order = calls.map((c) => c.model);
      expect(order.indexOf("user")).toBeLessThan(
        order.indexOf("replacementListing"),
      );
    });

    it("still purges the accounts when the ghost collection fails", async () => {
      // The two sweeps are independent. A failure on the second must not
      // discard the count of the first, nor throw: it runs again tomorrow.
      const prisma = {
        $queryRaw: async () => [{ locked: true }],
        user: {
          findMany: async () => [{ id: "u1" }],
          deleteMany: async () => ({ count: 4 }),
        },
        replacementListing: {
          deleteMany: async () => {
            throw new Error("boom");
          },
        },
      } as unknown as PrismaService;

      await expect(
        new DataLifecycleService(prisma).purgeAnonymizedAccounts(),
      ).resolves.toBeUndefined();
    });

    it("still collects ghosts when the account sweep fails", async () => {
      // The other direction, and the one that used to be missing. Both steps
      // shared a single `try`, so a transient lock or foreign-key error on the
      // cascade skipped the collection entirely and left orphan ghost listings
      // accumulating silently until the next run — a day, every time.
      let collected = false;
      const prisma = {
        $queryRaw: async () => [{ locked: true }],
        user: {
          findMany: async () => {
            throw new Error("boom");
          },
          deleteMany: async () => ({ count: 0 }),
        },
        replacementListing: {
          deleteMany: async () => {
            collected = true;
            return { count: 2 };
          },
        },
      } as unknown as PrismaService;

      await expect(
        new DataLifecycleService(prisma).purgeAnonymizedAccounts(),
      ).resolves.toBeUndefined();

      expect(collected).toBe(true);
    });

    it("stops when another replica already holds the lock", async () => {
      // Both sweeps are idempotent, so a duplicate run is harmless in effect —
      // but N replicas meant N full scans and N deletes of the same rows on the
      // same hour, in every process serving requests.
      const { prisma, calls } = makePrisma();
      (prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw =
        async () => [{ locked: false }];

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      expect(calls).toHaveLength(0);
    });

    it("drains the table in batches rather than one unbounded delete", async () => {
      const { prisma } = makePrisma();
      let reads = 0;
      let deletes = 0;
      (prisma as unknown as { user: unknown }).user = {
        // Always full, so the sweep has to keep going.
        findMany: async (args: { take: number }) => {
          reads += 1;
          return Array.from({ length: args.take }, (_, i) => ({
            id: `u${reads}-${i}`,
          }));
        },
        deleteMany: async () => {
          deletes += 1;
          return { count: 1_000 };
        },
      };

      await new DataLifecycleService(prisma).purgeAnonymizedAccounts();

      // 1 000 rows per statement, and the loop gives up rather than spinning on
      // a table it cannot drain.
      expect(reads).toBeGreaterThan(1);
      expect(deletes).toBe(reads);
    });
  });
});

describe("SystemScaffoldService", () => {
  it("recreates the three rows the ghost listings hang from", async () => {
    // They exist because one migration inserted them, and that migration is
    // `ON CONFLICT DO NOTHING` so it never runs again. A restore that excluded
    // them, or a deployment that went through `db:push`, never had them — and
    // every erasure touching a listing with a third-party application then died
    // on a foreign-key violation with nothing in the logs naming the cause.
    const { SystemScaffoldService } = await import(
      "../common/system-scaffold.service"
    );

    const upserts: Array<{ model: string; id: string }> = [];
    const prisma = {
      user: {
        upsert: async (args: { where: { id: string } }) => {
          upserts.push({ model: "user", id: args.where.id });
          return {};
        },
      },
      profile: {
        upsert: async (args: { where: { id: string } }) => {
          upserts.push({ model: "profile", id: args.where.id });
          return {};
        },
      },
      practice: {
        upsert: async (args: { where: { id: string } }) => {
          upserts.push({ model: "practice", id: args.where.id });
          return {};
        },
      },
    } as unknown as PrismaService;

    await new SystemScaffoldService(prisma).ensure();

    expect(upserts).toEqual([
      { model: "user", id: SYSTEM_SCAFFOLD.userId },
      { model: "profile", id: SYSTEM_SCAFFOLD.profileId },
      { model: "practice", id: SYSTEM_SCAFFOLD.practiceId },
    ]);
  });

  it("does not fail boot when the database is unreachable", async () => {
    const { SystemScaffoldService } = await import(
      "../common/system-scaffold.service"
    );

    const prisma = {
      user: {
        upsert: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as PrismaService;

    const service = new SystemScaffoldService(prisma);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
