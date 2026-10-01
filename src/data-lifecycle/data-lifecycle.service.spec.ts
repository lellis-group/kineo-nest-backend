import { describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import { PrismaService } from "../prisma.service";
import { DataLifecycleService } from "./data-lifecycle.service";

const DAY = 86_400_000;

type Call = { model: string; where: Record<string, never> };

function makePrisma() {
  const calls: Call[] = [];
  const record =
    (model: string) =>
    async ({ where }: { where: never }) => {
      calls.push({ model, where });
      return { count: 1 };
    };

  const prisma = {
    session: { deleteMany: record("session") },
    verification: { deleteMany: record("verification") },
    dataDeletionRequest: { deleteMany: record("dataDeletionRequest") },
    user: { deleteMany: record("user") },
    replacementListing: { deleteMany: record("replacementListing") },
  } as unknown as PrismaService;

  return { prisma, calls };
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

    expect(calls[0]).toMatchObject({ model: "session" });
    expect(calls[1]).toMatchObject({ model: "verification" });

    const where = calls[0].where as unknown as {
      expiresAt?: { lt?: Date };
    };
    expect(where.expiresAt?.lt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("bounds the trail with two horizons anchored on the last state change", async () => {
    const { prisma, calls } = makePrisma();

    await new DataLifecycleService(prisma).purgeExpired();

    const requests = calls.filter((c) => c.model === "dataDeletionRequest");
    expect(requests).toHaveLength(2);

    const [abandoned, executed] = requests.map(
      (c) => c.where as unknown as { status: unknown; updatedAt: { lt: Date } },
    );

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

    const requests = calls
      .filter((c) => c.model === "dataDeletionRequest")
      .map((c) => c.where as unknown as { updatedAt: { lt: Date } });

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
      const accountSweep = calls.filter((c) => c.model === "user");
      expect(accountSweep).toHaveLength(1);
      const where = accountSweep[0].where as unknown as {
        deletedAt: { lt: Date };
      };
      expect(daysBack(where.deletedAt.lt)).toBe(30);
    });

    it("honours the grace period override", async () => {
      const { prisma, calls } = makePrisma();

      await new DataLifecycleService(
        prisma,
        config({ accountPurgeGraceDays: 90 }),
      ).purgeAnonymizedAccounts();

      const where = calls[0].where as unknown as { deletedAt: { lt: Date } };
      expect(daysBack(where.deletedAt.lt)).toBe(90);
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
      const where = calls[0].where as unknown as {
        deletedAt: { lt: Date };
      };
      expect(Object.keys(where)).toEqual(["deletedAt"]);
      expect(where.deletedAt.lt).toBeInstanceOf(Date);
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
      expect(call).toHaveLength(1);
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
        user: { deleteMany: async () => ({ count: 4 }) },
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
  });
});
