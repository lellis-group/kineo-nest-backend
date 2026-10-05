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
    const prisma = {
      replacementListing: { findUnique: async () => listing },
      profile: { findUnique: async () => profile },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.update("listing-1", "user-1", {
        endDate: "2026-09-01T08:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
