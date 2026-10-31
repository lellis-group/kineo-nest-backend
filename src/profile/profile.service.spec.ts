import { describe, expect, it } from "bun:test";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";

import { PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE } from "../common/application-guard";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { ProfileService } from "./profile.service";

describe("ProfileService", () => {
  const owned = {
    id: "profile-1",
    userId: "user-1",
    isPublic: true,
    specialty: "GENERALIST",
    profileType: "INSTALLED",
    city: "Lyon",
    rppsNumber: "101000000001",
    // A real row carries it, and the response serializer demands it as an ISO
    // string — the mapper reads it off whatever the storage answered.
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  /**
   * The fake carries two views, like a real database does: the row the read
   * saw, and the row that answers at commit time. A deletion that lands between
   * the two is the case the update has to survive.
   */
  function serviceFor(row: typeof owned | null, commit: typeof owned | null) {
    const casCalls: Array<Record<string, unknown>> = [];
    const writes: Array<Record<string, unknown>> = [];
    let saved: typeof owned | null = commit;
    let writeHappened = false;

    const prisma = {
      profile: {
        findUnique: async () => (writeHappened ? saved : row),
        updateMany: async (args: {
          where: { id: string; userId: string };
          data: Record<string, unknown>;
        }) => {
          casCalls.push(args.where);

          const matched =
            saved !== null &&
            saved.id === args.where.id &&
            saved.userId === args.where.userId;

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
      service: new ProfileService(prisma),
    };
  }

  describe("update", () => {
    it("writes for the owner and reads the saved row back", async () => {
      const { writes, service } = serviceFor(owned, owned);

      const result = await service.update("profile-1", "user-1", {
        city: "Paris",
      });

      expect(result.city).toBe("Paris");
      expect(writes).toEqual([{ city: "Paris" }]);
    });

    it("hands the storage a write that carries the ownership", async () => {
      const { casCalls, service } = serviceFor(owned, owned);
      await service.update("profile-1", "user-1", { city: "Paris" });

      expect(casCalls).toEqual([{ id: "profile-1", userId: "user-1" }]);
    });

    it("lets only the owner write", async () => {
      const { service } = serviceFor(
        { ...owned, isPublic: true, userId: "user-2" },
        { ...owned, isPublic: true, userId: "user-2" },
      );

      await expect(
        service.update("profile-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("answers 404 to a profile that does not exist", async () => {
      const { service } = serviceFor(null, null);

      await expect(
        service.update("profile-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers 404 to a profile deleted while the write was held, instead of a raw P2025", async () => {
      const { writes, deleted, service } = serviceFor(owned, owned);
      deleted();

      await expect(
        service.update("profile-1", "user-1", { city: "Paris" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(writes).toHaveLength(0);
    });

    it("maps a taken RPPS number to a conflict", async () => {
      const prisma = {
        profile: {
          findUnique: async () => owned,
          updateMany: async () => {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              { code: "P2002", clientVersion: "test" },
            );
          },
        },
      } as unknown as PrismaService;
      const service = new ProfileService(prisma);

      await expect(
        service.update("profile-1", "user-1", { rppsNumber: "199999999999" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("create", () => {
    it("creates the one profile a user has", async () => {
      const created: unknown[] = [];
      const prisma = {
        profile: {
          findUnique: async () => null,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.push(data);
            return { ...owned };
          },
        },
      } as unknown as PrismaService;

      const result = await new ProfileService(prisma).create("user-1", {
        specialty: "GENERALIST",
        profileType: "INSTALLED",
        city: "Lyon",
        rppsNumber: "101000000001",
      } as never);

      expect(result.id).toBe("profile-1");
      expect(created[0]).toMatchObject({ userId: "user-1" });
    });

    it("refuses the second profile a user tries to hold", async () => {
      const prisma = {
        profile: { findUnique: async () => owned },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).create("user-1", {} as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("maps a taken RPPS number to a conflict", async () => {
      const prisma = {
        profile: {
          findUnique: async () => null,
          create: async () => {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              { code: "P2002", clientVersion: "test" },
            );
          },
        },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).create("user-1", {} as never),
      ).rejects.toThrow("RPPS number already in use");
    });

    it("names the user race on the key it lost, not the RPPS one", async () => {
      // Both writes go through one guard clause, and before it looked the
      // target up, the pre-check's own race — two first submissions of one
      // user — also read "RPPS number already in use". A caller retrying that
      // advice then heard the wrong story forever: their RPPS was fine, the
      // profile was the thing that had come into existence.
      const prisma = {
        profile: {
          findUnique: async () => null,
          create: async () => {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              {
                code: "P2002",
                clientVersion: "test",
                meta: { target: ["User", "userId", "Profile_userId_key"] },
              },
            );
          },
        },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).create("user-1", {} as never),
      ).rejects.toThrow("Profile already exists for this user");
    });
  });

  describe("findAll", () => {
    it("returns the public page and its count", async () => {
      let where: unknown;
      const prisma = {
        profile: {
          findMany: async (args: { where: unknown }) => {
            where = args.where;
            return [owned];
          },
          count: async () => 1,
        },
      } as unknown as PrismaService;

      const result = await new ProfileService(prisma).findAll({
        page: 1,
        limit: 20,
        city: "Lyon",
      } as never);

      expect(result.data).toHaveLength(1);
      expect(result.meta).toMatchObject({ total: 1, page: 1, totalPages: 1 });
      expect(where).toMatchObject({ isPublic: true, city: "Lyon" });
    });
  });

  describe("findOne and findByUserId", () => {
    it("answers 404 to a profile that does not exist", async () => {
      const prisma = {
        profile: { findUnique: async () => null },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).findOne("profile-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("hides a private profile behind the same 404, from a stranger", async () => {
      const prisma = {
        profile: { findUnique: async () => ({ ...owned, isPublic: false }) },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).findOne("profile-1", "user-2"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers a private profile to its owner", async () => {
      const prisma = {
        profile: { findUnique: async () => ({ ...owned, isPublic: false }) },
      } as unknown as PrismaService;

      const result = await new ProfileService(prisma).findOne(
        "profile-1",
        "user-1",
      );

      expect(result.id).toBe("profile-1");
    });

    it("answers 404 when no profile belongs to the user", async () => {
      const prisma = {
        profile: { findUnique: async () => null },
      } as unknown as PrismaService;

      await expect(
        new ProfileService(prisma).findByUserId("user-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("remove", () => {
    function transactionFor(row: typeof owned | null, thirdPartyCount: number) {
      const options: unknown[] = [];
      const deleted: string[] = [];

      const transactionClient = {
        profile: {
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
          transactionOptions: unknown,
        ) => {
          options.push(transactionOptions);
          return operation(transactionClient);
        },
      } as unknown as PrismaService;

      return { deleted, options, service: new ProfileService(prisma) };
    }

    it("deletes the owner's profile in a serializable transaction", async () => {
      const { deleted, options, service } = transactionFor(owned, 0);

      await service.remove("profile-1", "user-1");

      expect(deleted).toEqual(["profile-1"]);
      expect(options[0]).toMatchObject({ isolationLevel: "Serializable" });
    });

    it("refuses a deletion that would erase someone else's application", async () => {
      const { service } = transactionFor(owned, 1);

      const error = await service.remove("profile-1", "user-1").then(
        () => null,
        (caught: unknown) => caught as ConflictException,
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error?.getResponse() as { message?: string }).message).toContain(
        PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE.slice(0, 40),
      );
    });

    it("answers 404 to a profile that does not exist", async () => {
      const { service } = transactionFor(null, 0);

      await expect(
        service.remove("profile-1", "user-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lets only the owner delete", async () => {
      const { service } = transactionFor({ ...owned, userId: "user-2" }, 0);

      await expect(
        service.remove("profile-1", "user-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
