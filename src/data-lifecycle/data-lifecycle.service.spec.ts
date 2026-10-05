import { describe, expect, it } from "bun:test";
import { PrismaService } from "../prisma.service";
import { DataLifecycleService } from "./data-lifecycle.service";

describe("DataLifecycleService", () => {
  it("purges expired sessions, verifications and expired deletion requests", async () => {
    const calls: { model: string; where: unknown }[] = [];
    const prisma = {
      session: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push({ model: "session", where });
          return { count: 3 };
        },
      },
      verification: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push({ model: "verification", where });
          return { count: 2 };
        },
      },
      dataDeletionRequest: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push({ model: "dataDeletionRequest", where });
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;

    const service = new DataLifecycleService(prisma);
    await service.purgeExpired();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ model: "session" });
    expect(calls[1]).toMatchObject({ model: "verification" });
    expect(calls[2]).toMatchObject({ model: "dataDeletionRequest" });

    const sessionCutoff = (calls[0].where ?? {}) as {
      expiresAt?: { lt?: Date };
    };
    expect(sessionCutoff.expiresAt?.lt).toBeInstanceOf(Date);
    expect(sessionCutoff.expiresAt?.lt?.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );

    // Default retention is 365 days: the cutoff must sit ~1 year in the past.
    const deletionWhere = (calls[2].where ?? {}) as {
      createdAt?: { lt?: Date };
    };
    const cutoff = deletionWhere.createdAt?.lt;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff?.getTime()).toBeLessThan(Date.now() - 364 * 86_400_000);
    expect(cutoff?.getTime()).toBeGreaterThan(Date.now() - 366 * 86_400_000);
  });

  it("never throws when the sweep fails", async () => {
    const prisma = {
      session: {
        deleteMany: async () => {
          throw new Error("boom");
        },
      },
      verification: {
        deleteMany: async () => ({ count: 0 }),
      },
      dataDeletionRequest: {
        deleteMany: async () => ({ count: 0 }),
      },
    } as unknown as PrismaService;

    const service = new DataLifecycleService(prisma);
    await expect(service.purgeExpired()).resolves.toBeUndefined();
  });
});
