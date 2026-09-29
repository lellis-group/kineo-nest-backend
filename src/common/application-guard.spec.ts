import { describe, expect, it } from "bun:test";
import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "../prisma.service";
import {
  assertNoThirdPartyApplications,
  countThirdPartyActiveApplications,
} from "./application-guard";

function prismaWithCount(count: number) {
  return {
    application: { count: async () => count },
  } as unknown as PrismaService;
}

describe("assertNoThirdPartyApplications", () => {
  it("allows deletion when no third-party application exists", async () => {
    await expect(
      assertNoThirdPartyApplications(prismaWithCount(0), "profile-1", {
        practiceId: "practice-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks deletion when third-party applications are active", async () => {
    expect(
      assertNoThirdPartyApplications(prismaWithCount(1), "profile-1", {
        practiceId: "practice-1",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("excludes the owner's own applications from the count", async () => {
    const captured: unknown[] = [];
    const prisma = {
      application: {
        count: async (args: unknown) => {
          captured.push(args);
          return 0;
        },
      },
    } as unknown as PrismaService;

    await assertNoThirdPartyApplications(prisma, "profile-1", {
      id: "listing-1",
    });

    expect(captured[0]).toMatchObject({
      where: {
        applicantId: { not: "profile-1" },
        status: { in: ["PENDING", "SHORTLISTED", "ACCEPTED"] },
      },
    });
  });

  it("blocks deletion when a third-party placement was accepted", async () => {
    const prisma = {
      application: {
        count: async () => 1,
      },
    } as unknown as PrismaService;

    // `accept` writes a real placement, and the cascade would take it along
    // with the candidate's message and the practice's decision. A FILLED
    // listing used to pass the guard with a zero count.
    await expect(
      assertNoThirdPartyApplications(prisma, "profile-1", {
        id: "listing-1",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("ignores applications left on listings that no longer recruit", async () => {
    const captured: unknown[] = [];
    const prisma = {
      application: {
        count: async (args: unknown) => {
          captured.push(args);
          return 0;
        },
      },
    } as unknown as PrismaService;

    await assertNoThirdPartyApplications(prisma, "profile-1", {
      OR: [
        { createdById: "profile-1" },
        { practice: { ownerId: "profile-1" } },
      ],
    });

    expect(captured[0]).toMatchObject({
      where: {
        listing: {
          OR: [
            { createdById: "profile-1" },
            { practice: { ownerId: "profile-1" } },
          ],
          status: {
            in: ["DRAFT", "OPEN", "IN_DISCUSSION", "FULL", "FILLED"],
          },
        },
      },
    });
  });

  it("reports the caller supplied conflict message", async () => {
    const prisma = prismaWithCount(3);

    await expect(
      assertNoThirdPartyApplications(prisma, "profile-1", {}, "Custom reason"),
    ).rejects.toThrow("Custom reason");
  });
});

describe("countThirdPartyActiveApplications", () => {
  it("returns zero for a user without a profile", async () => {
    const prisma = {
      profile: { findUnique: async () => null },
      application: {
        count: async () => {
          throw new Error("should not be called");
        },
      },
    } as unknown as PrismaService;

    expect(await countThirdPartyActiveApplications(prisma, "user-1")).toBe(0);
  });

  it("counts the applications that would block the erasure", async () => {
    const captured: unknown[] = [];
    const prisma = {
      profile: { findUnique: async () => ({ id: "profile-1" }) },
      application: {
        count: async (args: unknown) => {
          captured.push(args);
          return 3;
        },
      },
    } as unknown as PrismaService;

    expect(await countThirdPartyActiveApplications(prisma, "user-1")).toBe(3);
    expect(captured[0]).toMatchObject({
      where: {
        applicantId: { not: "profile-1" },
        status: { in: ["PENDING", "SHORTLISTED", "ACCEPTED"] },
        listing: {
          OR: [
            { createdById: "profile-1" },
            { practice: { ownerId: "profile-1" } },
          ],
        },
      },
    });
  });
});
