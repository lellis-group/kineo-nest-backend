import { describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
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

      expect(calls).toHaveLength(1);
      const where = calls[0].where as unknown as { deletedAt: { lt: Date } };
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
});
