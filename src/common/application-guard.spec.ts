import { describe, expect, it } from "bun:test";
import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client";
import {
  assertNoThirdPartyApplications,
  LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
  PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
  thirdPartyActiveApplicationsFilter,
} from "./application-guard";
import {
  ACTIVE_APPLICATION_STATUSES,
  RECRUITING_LISTING_STATUSES,
} from "./listing-status";

function makePrisma(count: number) {
  const calls: unknown[] = [];
  return {
    calls,
    application: {
      count: async (args: unknown) => {
        calls.push(args);
        return count;
      },
    },
  } as never;
}

describe("thirdPartyActiveApplicationsFilter", () => {
  it("excludes the owner's own applications", () => {
    const filter = thirdPartyActiveApplicationsFilter("profile-1");

    expect(filter).toMatchObject({
      AND: [{ OR: expect.anything() }, { applicantId: { not: "profile-1" } }],
    });
  });

  it("drops a caller status filter so an accepted placement is never filtered out", () => {
    const filter = thirdPartyActiveApplicationsFilter("profile-1", {
      status: "OPEN",
      practiceId: "practice-1",
    });
    const branches = (filter as { AND: [{ OR: { listing: object }[] }] }).AND[0]
      .OR;

    expect(branches[0].listing).toEqual({ practiceId: "practice-1" });
    expect(branches[0].listing).not.toHaveProperty("status");
  });

  it("counts an accepted placement whatever the listing went on to become", () => {
    const filter = thirdPartyActiveApplicationsFilter("profile-1", {
      status: "CLOSED",
      practiceId: "practice-1",
    });
    const branches = (filter as { AND: [{ OR: object[] }] }).AND[0].OR;

    expect(branches[0]).toEqual({
      listing: { practiceId: "practice-1" },
      status: "ACCEPTED",
    });
    expect(branches[1]).toEqual({
      listing: {
        practiceId: "practice-1",
        status: { in: RECRUITING_LISTING_STATUSES },
      },
      status: { in: ACTIVE_APPLICATION_STATUSES },
    });
  });
});

describe("assertNoThirdPartyApplications", () => {
  it("passes when the account has no third-party application", async () => {
    await expect(
      assertNoThirdPartyApplications(makePrisma(0), "profile-1"),
    ).resolves.toBeUndefined();
  });

  it("refuses the deletion and names the blocking statuses", async () => {
    const prisma = makePrisma(1);

    await expect(
      assertNoThirdPartyApplications(prisma, "profile-1"),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      assertNoThirdPartyApplications(makePrisma(1), "profile-1"),
    ).rejects.toThrow(PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE);
  });

  it("uses the caller's message when one is given", async () => {
    await expect(
      assertNoThirdPartyApplications(
        makePrisma(2),
        "profile-1",
        { id: "listing-1" } as Prisma.ReplacementListingWhereInput,
        LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
      ),
    ).rejects.toThrow(LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE);
  });
});
