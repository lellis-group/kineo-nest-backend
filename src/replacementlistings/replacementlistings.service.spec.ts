import { describe, expect, it } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  REASON_LISTING_CANCELLED,
  REASON_LISTING_CLOSED,
} from "../applications/rejection-reasons";
import { PrismaService } from "../prisma.service";
import { ReplacementlistingsService } from "./replacementlistings.service";

const profile = { id: "profile-1", userId: "user-1" };
const listing = {
  id: "listing-1",
  practiceId: "practice-1",
  createdById: profile.id,
  startDate: new Date("2026-09-10T08:00:00.000Z"),
  endDate: new Date("2026-09-12T08:00:00.000Z"),
  specialty: "GENERALIST",
  status: "DRAFT",
  urgent: false,
  description: null,
  maxApplications: null,
  createdAt: new Date("2026-08-20T08:00:00.000Z"),
  updatedAt: new Date("2026-08-20T08:00:00.000Z"),
};

const openListing = { ...listing, status: "OPEN" };

describe("ReplacementlistingsService", () => {
  it("persists maxApplications when creating a listing", async () => {
    let createData: unknown;
    const transactionClient = {
      practice: {
        findUnique: async () => ({ id: "practice-1", ownerId: profile.id }),
      },
      replacementListing: {
        count: async () => 0,
        create: async ({ data }: { data: unknown }) => {
          createData = data;
          return { ...listing, maxApplications: 3 };
        },
      },
    };
    const prisma = {
      profile: { findUnique: async () => profile },
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await service.create("user-1", {
      practiceId: "practice-1",
      startDate: "2026-09-10T08:00:00.000Z",
      endDate: "2026-09-12T08:00:00.000Z",
      specialty: "GENERALIST",
      maxApplications: 3,
    });

    expect(createData).toMatchObject({ maxApplications: 3 });
  });

  it("rejects a partial date update that would invalidate a listing", async () => {
    const transactionClient = {
      replacementListing: { findUnique: async () => listing },
      profile: { findUnique: async () => profile },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.update("listing-1", "user-1", {
        endDate: "2026-09-01T08:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reopens a FULL listing when the owner raises maxApplications", async () => {
    // A FULL listing whose cap is raised must stop being FULL, otherwise it
    // refuses every candidate with free slots and nothing in the module can
    // undo that: the only writes that move an application out of the active
    // set are reject/withdraw, which is what FULL is supposed to unblock.
    const fullListing = { ...listing, status: "FULL", maxApplications: 2 };
    const updateCalls: Array<{ data: Record<string, unknown> }> = [];

    const transactionClient = {
      replacementListing: {
        findUnique: async () => fullListing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateCalls.push({ data });
          return { ...fullListing, _count: { applications: 0 } };
        },
        findUniqueOrThrow: async () => ({
          ...fullListing,
          status: "IN_DISCUSSION",
          maxApplications: 5,
          _count: { applications: 0 },
        }),
      },
      application: {
        count: async () => 2,
      },
      profile: { findUnique: async () => profile },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.update("listing-1", "user-1", {
      maxApplications: 5,
    });

    // 2 active applications against a cap of 5 is IN_DISCUSSION, not FULL.
    expect(result.status).toBe("IN_DISCUSSION");
    expect(updateCalls[0]?.data).toMatchObject({ maxApplications: 5 });
  });

  it("keeps a FULL listing FULL when maxApplications is left alone", async () => {
    const fullListing = { ...listing, status: "FULL", maxApplications: 2 };
    const updated = {
      ...fullListing,
      title: "New title",
      _count: { applications: 0 },
    };

    const transactionClient = {
      replacementListing: {
        findUnique: async () => fullListing,
        update: async () => updated,
        // A recalc would be wrong here: no capacity changed.
        findUniqueOrThrow: async () => {
          throw new Error("status must not be recalculated");
        },
      },
      application: {
        count: async () => {
          throw new Error("status must not be recalculated");
        },
      },
      profile: { findUnique: async () => profile },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.update("listing-1", "user-1", {
      title: "New title",
    });

    expect(result.status).toBe("FULL");
  });

  it("allows anyone to view an OPEN listing", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1");
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("allows anonymous users to view an OPEN listing", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1", undefined);
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("blocks unauthenticated access to non-OPEN listings", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.findOne("listing-1", undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows owner to view their own non-OPEN listing", async () => {
    const prisma = {
      profile: { findUnique: async () => profile },
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1", "user-1");
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("blocks non-owner from viewing non-OPEN listings", async () => {
    const otherProfile = { id: "profile-2", userId: "user-2" };
    const prisma = {
      profile: { findUnique: async () => otherProfile },
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(service.findOne("listing-1", "user-2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns 404 when listing does not exist", async () => {
    const prisma = {
      replacementListing: { findUnique: async () => null },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(service.findOne("nonexistent-id")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe.each([
    ["close", REASON_LISTING_CLOSED],
    ["cancel", REASON_LISTING_CANCELLED],
  ] as const)("%s", (method, reason) => {
    function makeService(status: string) {
      const calls: string[] = [];
      const transactionClient = {
        profile: { findUnique: async () => profile },
        replacementListing: {
          findUnique: async () => ({ ...listing, status }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            calls.push("listing.update");
            return { ...listing, ...data, _count: { applications: 0 } };
          },
        },
        application: {
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            calls.push("application.updateMany");
            applicationData = data;
            return { count: 2 };
          },
        },
      };
      const prisma = {
        $transaction: async (
          operation: (tx: typeof transactionClient) => unknown,
        ) => operation(transactionClient),
      } as unknown as PrismaService;
      const config = { get: () => undefined } as unknown as ConfigService;

      return {
        calls,
        service: new ReplacementlistingsService(prisma, config),
      };
    }

    let applicationData: Record<string, unknown> | undefined;

    it("terminates active applications so the owner is not blocked from deleting", async () => {
      const { calls, service } = makeService("OPEN");

      await service[method]("listing-1", "user-1");

      expect(calls).toEqual(["application.updateMany", "listing.update"]);
      expect(applicationData).toMatchObject({
        status: "REJECTED",
        rejectionReason: reason,
      });
    });
  });

  it("rejects closing a listing that does not exist", async () => {
    const transactionClient = {
      profile: { findUnique: async () => profile },
      replacementListing: { findUnique: async () => null },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.close("nonexistent-id", "user-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects closing a listing that is not open or filled", async () => {
    const transactionClient = {
      profile: { findUnique: async () => profile },
      replacementListing: { findUnique: async () => listing },
      application: { updateMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(service.close("listing-1", "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe("findMine status buckets", () => {
    /**
     * Records the two distinct `where` clauses the service builds: one for the
     * page (status-filtered) and one for the counters (not filtered).
     */
    function makeService(statuses: string[]) {
      const pageWheres: Record<string, unknown>[] = [];
      const countWheres: Record<string, unknown>[] = [];
      const groupByWheres: Record<string, unknown>[] = [];

      const prisma = {
        profile: { findUnique: async () => profile },
        replacementListing: {
          findMany: async ({ where }: { where: Record<string, unknown> }) => {
            pageWheres.push(where);
            return [];
          },
          count: async ({ where }: { where: Record<string, unknown> }) => {
            countWheres.push(where);
            return 0;
          },
          groupBy: async ({ where }: { where: Record<string, unknown> }) => {
            groupByWheres.push(where);
            return statuses.map((status) => ({ status, _count: 1 }));
          },
        },
      } as unknown as PrismaService;

      const config = { get: () => undefined } as unknown as ConfigService;
      return {
        service: new ReplacementlistingsService(prisma, config),
        pageWheres,
        countWheres,
        groupByWheres,
      };
    }

    it("counts every status regardless of the active filter", async () => {
      const { service, groupByWheres } = makeService([
        "OPEN",
        "IN_DISCUSSION",
        "FULL",
        "FILLED",
        "CLOSED",
        "CANCELLED",
        "DRAFT",
      ]);

      const result = await service.findMine("user-1", {
        page: 1,
        limit: 20,
        status: ["OPEN", "IN_DISCUSSION", "FULL"],
      });

      // Counters ignore the filter, otherwise the tabs of the other buckets
      // would all read 0 and become unclickable.
      expect(groupByWheres[0]).toEqual({ createdById: profile.id });
      expect(result.meta.counts).toMatchObject({
        total: 7,
        OPEN: 1,
        IN_DISCUSSION: 1,
        FULL: 1,
        FILLED: 1,
        CLOSED: 1,
        CANCELLED: 1,
        DRAFT: 1,
      });
    });

    it("applies the status filter to the page but not to the totals", async () => {
      const { service, pageWheres, countWheres, groupByWheres } = makeService([
        "OPEN",
      ]);

      await service.findMine("user-1", {
        page: 1,
        limit: 20,
        status: ["OPEN", "FULL"],
      });

      expect(pageWheres[0]).toMatchObject({
        createdById: profile.id,
        status: { in: ["OPEN", "FULL"] },
      });
      expect(countWheres[0]).toMatchObject({
        createdById: profile.id,
        status: { in: ["OPEN", "FULL"] },
      });
      expect(groupByWheres[0]).not.toHaveProperty("status");
    });

    it("leaves the page unfiltered when no status is requested", async () => {
      const { service, pageWheres } = makeService(["OPEN"]);

      await service.findMine("user-1", { page: 1, limit: 20 });

      expect(pageWheres[0]).toEqual({ createdById: profile.id });
    });

    it("zeroes every counter on an empty collection", async () => {
      const { service } = makeService([]);

      const result = await service.findMine("user-1", { page: 1, limit: 20 });

      expect(result.meta.counts).toEqual({
        total: 0,
        DRAFT: 0,
        OPEN: 0,
        IN_DISCUSSION: 0,
        FULL: 0,
        FILLED: 0,
        CLOSED: 0,
        CANCELLED: 0,
      });
    });
  });
});
