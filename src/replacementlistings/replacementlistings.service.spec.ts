import { describe, expect, it } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
      title: "General practitioner",
      startDate: "2026-09-10T08:00:00.000Z",
      endDate: "2026-09-12T08:00:00.000Z",
      specialty: "GENERALIST",
      maxApplications: 3,
    });

    expect(createData).toMatchObject({ maxApplications: 3 });
  });

  it("rejects a partial date update that would invalidate a listing", async () => {
    // `update` runs in a transaction, so the fake has to offer one.
    const reads = {
      replacementListing: { findUnique: async () => listing },
      profile: { findUnique: async () => profile },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.update("listing-1", "user-1", {
        endDate: "2026-09-01T08:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("re-derives the status when maxApplications changes", async () => {
    // A `FULL` listing whose owner raises the cap used to stay `FULL` and refuse
    // every candidate it had room for. The capacity is an input to the
    // derivation, so writing it without re-deriving leaves the row asserting
    // something the code no longer believes — and no transition could undo it.
    const full = {
      ...openListing,
      status: "FULL",
      maxApplications: 2,
    };
    const writes: { status?: string } = {};
    let row = { ...full };

    const reads = {
      profile: { findUnique: async () => profile },
      application: { count: async () => 2 },
      replacementListing: {
        findUnique: async () => row,
        findUniqueOrThrow: async () => ({
          ...row,
          _count: { applications: 2 },
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          writes.status = args.data.status as string | undefined;
          // Prisma ignores `undefined` inside a data object, so the fake has to
          // as well — otherwise it blanks the dates the service left alone and the
          // failure looks like a date bug.
          const defined = Object.fromEntries(
            Object.entries(args.data).filter(
              ([, value]) => value !== undefined,
            ),
          );
          row = { ...row, ...defined };
          return { ...row, _count: { applications: 2 } };
        },
      },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const updated = await service.update("listing-1", "user-1", {
      maxApplications: 5,
    });

    // Two active applications against a cap of five is IN_DISCUSSION, and the
    // response has to carry the status that was written.
    expect(writes.status).toBe("IN_DISCUSSION");
    expect(updated.status).toBe("IN_DISCUSSION");
  });

  it("leaves the status alone when the capacity did not change", async () => {
    let recalculated = false;
    const reads = {
      profile: { findUnique: async () => profile },
      application: {
        count: async () => {
          recalculated = true;
          return 0;
        },
      },
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
        findUniqueOrThrow: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
        update: async () => ({ ...openListing, _count: { applications: 0 } }),
      },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await service.update("listing-1", "user-1", { title: "New title" });

    // A title does not move the derivation, so it is not run: one fewer count on
    // a path that runs on every edit.
    expect(recalculated).toBe(false);
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
});
