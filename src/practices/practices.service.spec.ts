import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE } from "../common/application-guard";
import { PrismaService } from "../prisma.service";
import { PracticesService } from "./practices.service";

describe("PracticesService", () => {
  const owned = {
    id: "practice-1",
    ownerId: "profile-1",
    isPublic: true,
    name: "Cabinet Lyon",
    city: "Lyon",
  };

  function configFor(limits?: number) {
    return {
      get: (key: string) =>
        key === "limits.practicesPerProfile" ? limits : undefined,
    } as unknown as ConfigService;
  }

  /**
   * Two views, like a real database: the row the read saw and the row that
   * answers at commit time. A practice deleted in between is the case the
   * update has to answer 404 to instead of a raw P2025.
   */
  function serviceFor(row: typeof owned | null, commit: typeof owned | null) {
    const casCalls: Array<Record<string, unknown>> = [];
    const writes: Array<Record<string, unknown>> = [];
    let saved: typeof owned | null = commit;
    let writeHappened = false;

    const prisma = {
      profile: { findUnique: async () => ({ id: "profile-1" }) },
      practice: {
        findUnique: async () => (writeHappened ? saved : row),
        updateMany: async (args: {
          where: { id: string; ownerId: string };
          data: Record<string, unknown>;
        }) => {
          casCalls.push(args.where);

          const matched =
            saved !== null &&
            saved.id === args.where.id &&
            saved.ownerId === args.where.ownerId;

          if (!matched) {
            return { count: 0 };
          }

          writes.push(args.data);
          writeHappened = true;
          saved = { ...saved, ...args.data } as typeof owned;
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;

    return {
      casCalls,
      writes,
      deleted: () => (saved = null),
      service: new PracticesService(prisma, configFor()),
    };
  }

  describe("update", () => {
    it("writes for the owner and reads the saved row back", async () => {
      const { writes, service } = serviceFor(owned, owned);

      const result = await service.update("practice-1", "user-1", {
        city: "Paris",
      });

      expect(result.city).toBe("Paris");
      expect(writes).toEqual([{ city: "Paris" }]);
    });

    it("hands the storage a write that carries the ownership", async () => {
      const { casCalls, service } = serviceFor(owned, owned);
      await service.update("practice-1", "user-1", { city: "Paris" });

      expect(casCalls).toEqual([{ id: "practice-1", ownerId: "profile-1" }]);
    });

    it("lets only the owner write", async () => {
      const { service } = serviceFor(
        { ...owned, ownerId: "profile-2" },
        { ...owned, ownerId: "profile-2" },
      );

      await expect(
        service.update("practice-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("answers 404 to a practice that does not exist", async () => {
      const { service } = serviceFor(null, null);

      await expect(
        service.update("practice-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers 404 to a practice deleted while the write was held, instead of a raw P2025", async () => {
      const { writes, deleted, service } = serviceFor(owned, owned);
      deleted();

      await expect(
        service.update("practice-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(writes).toHaveLength(0);
    });
  });

  describe("create", () => {
    it("creates for the owner's profile in a serializable transaction", async () => {
      let options: unknown;
      let created: Record<string, unknown> | undefined;
      const transactionClient = {
        practice: {
          count: async () => 0,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created = data;
            return { ...owned };
          },
        },
      };
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        $transaction: async (
          operation: (tx: typeof transactionClient) => unknown,
          transactionOptions: unknown,
        ) => {
          options = transactionOptions;
          return operation(transactionClient);
        },
      } as unknown as PrismaService;

      const result = await new PracticesService(prisma, configFor()).create(
        "user-1",
        { name: "Cabinet", address: "1 rue", city: "Lyon" } as never,
      );

      expect(result.id).toBe("practice-1");
      expect(created).toMatchObject({ ownerId: "profile-1" });
      expect(options).toMatchObject({ isolationLevel: "Serializable" });
    });

    it("refuses past the configured quota", async () => {
      const transactionClient = {
        practice: { count: async () => 1 },
      };
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        $transaction: async (
          operation: (tx: typeof transactionClient) => unknown,
        ) => operation(transactionClient),
      } as unknown as PrismaService;

      await expect(
        new PracticesService(prisma, configFor(1)).create(
          "user-1",
          {} as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("findAll", () => {
    it("returns the flat page when no coordinates come along", async () => {
      let where: unknown;
      const prisma = {
        practice: {
          findMany: async (args: { where: unknown }) => {
            where = args.where;
            return [owned];
          },
          count: async () => 1,
        },
      } as unknown as PrismaService;

      const result = await new PracticesService(prisma, configFor()).findAll({
        page: 1,
        limit: 20,
        city: "Lyon",
      } as never);

      expect(result.data).toHaveLength(1);
      expect(result.meta).toMatchObject({ total: 1 });
      expect(where).toMatchObject({
        isPublic: true,
        city: { contains: "Lyon" },
      });
    });

    it("reads the geo page and its count off two statements", async () => {
      const statements: string[] = [];
      const prisma = {
        $queryRaw: async (statement: { sql: string }) => {
          statements.push(statement.sql);
          return statements.length === 1 ? [owned] : [{ total: 3n }];
        },
      } as unknown as PrismaService;

      const result = await new PracticesService(prisma, configFor()).findAll({
        page: 1,
        limit: 20,
        lat: 0,
        lng: 0,
        radiusKm: 50,
      } as never);

      expect(result.data).toHaveLength(1);
      expect(result.meta).toMatchObject({ total: 3 });
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("asin");
      expect(statements[1]).toContain("COUNT(*)");
    });
  });

  describe("findOne and findMine", () => {
    it("answers 404 to a practice that does not exist", async () => {
      const prisma = {
        practice: { findUnique: async () => null },
      } as unknown as PrismaService;

      await expect(
        new PracticesService(prisma, configFor()).findOne("practice-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("hides a private practice behind the same 404, from a stranger", async () => {
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-2" }) },
        practice: { findUnique: async () => ({ ...owned, isPublic: false }) },
      } as unknown as PrismaService;

      await expect(
        new PracticesService(prisma, configFor()).findOne(
          "practice-1",
          "user-2",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers a private practice to its owner", async () => {
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        practice: { findUnique: async () => ({ ...owned, isPublic: false }) },
      } as unknown as PrismaService;

      const result = await new PracticesService(prisma, configFor()).findOne(
        "practice-1",
        "user-1",
      );

      expect(result.id).toBe("practice-1");
    });

    it("answers the owner's practices to the owner", async () => {
      let where: unknown;
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        practice: {
          findMany: async (args: { where: unknown }) => {
            where = args.where;
            return [owned];
          },
        },
      } as unknown as PrismaService;

      const result = await new PracticesService(prisma, configFor()).findMine(
        "user-1",
      );

      expect(result).toHaveLength(1);
      expect(where).toEqual({ ownerId: "profile-1" });
    });
  });

  describe("remove", () => {
    function transactionFor(row: typeof owned | null, thirdPartyCount: number) {
      const deleted: string[] = [];

      const transactionClient = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        practice: {
          findUnique: async () => row,
          delete: async ({ where }: { where: { id: string } }) => {
            deleted.push(where.id);
            return row;
          },
        },
        application: { count: async () => thirdPartyCount },
      };
      const prisma = {
        $transaction: async (
          operation: (tx: typeof transactionClient) => unknown,
        ) => operation(transactionClient),
      } as unknown as PrismaService;

      return { deleted, service: new PracticesService(prisma, configFor()) };
    }

    it("deletes the owner's practice in a serializable transaction", async () => {
      const { deleted, service } = transactionFor(owned, 0);

      await service.remove("practice-1", "user-1");

      expect(deleted).toEqual(["practice-1"]);
    });

    it("refuses a deletion that would erase someone else's application", async () => {
      const { service } = transactionFor(owned, 1);

      const error = await service.remove("practice-1", "user-1").then(
        () => null,
        (caught: unknown) => caught as Error,
      );

      expect(error?.message).toContain(
        PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE.slice(0, 40),
      );
    });

    it("answers 404 to a practice that does not exist", async () => {
      const { service } = transactionFor(null, 0);

      await expect(
        service.remove("practice-1", "user-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lets only the owner delete", async () => {
      const { service } = transactionFor({ ...owned, ownerId: "profile-2" }, 0);

      await expect(
        service.remove("practice-1", "user-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
