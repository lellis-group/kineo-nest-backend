import { describe, expect, it } from "bun:test";
import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "../prisma.service";
import { assertNoThirdPartyApplications } from "./application-guard";

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
        listing: { id: "listing-1" },
        applicantId: { not: "profile-1" },
        status: { in: ["PENDING", "SHORTLISTED"] },
      },
    });
  });
});
