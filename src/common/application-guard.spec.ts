import { describe, expect, it } from "bun:test";
import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client";
import {
  assertNoThirdPartyApplications,
  countThirdPartyApplications,
  LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
  ownedListingsFilter,
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

describe("ownedListingsFilter", () => {
  /**
   * The two ways an account owns a posting.
   *
   * Written out twice over in the three teardown paths before it was factored
   * out here, which is how the halves of an account deletion could disagree
   * about whose applications were at stake — and one of the two disagreements
   * makes the deletion refuse for a posting that has nothing to do with the
   * account.
   */
  it("covers the postings it created and those its practices carry", () => {
    expect(ownedListingsFilter("profile-1")).toEqual({
      OR: [
        { createdById: "profile-1" },
        { practice: { ownerId: "profile-1" } },
      ],
    });
  });
});

describe("countThirdPartyApplications", () => {
  /** A prisma that answers the profile lookup, and records the count's predicate. */
  function makePrismaForCount(profileId: string | null, count: number) {
    const counts: unknown[] = [];
    return {
      counts,
      client: {
        profile: {
          findUnique: async () => (profileId ? { id: profileId } : null),
        },
        application: {
          count: async (args: unknown) => {
            counts.push(args);
            return count;
          },
        },
      } as never,
    };
  }

  it("answers zero, and reads nothing, for an account that has no profile", async () => {
    // A session can outlive its profile, and the erasure flow counts before it
    // sends: a count that looked the profile up and found nothing has to be a
    // zero, not a lookup on `undefined`.
    const { client, counts } = makePrismaForCount(null, 7);

    await expect(countThirdPartyApplications(client, "user-1")).resolves.toBe(
      0,
    );
    expect(counts).toHaveLength(0);
  });

  it("counts over the account's own postings, whoever applied", async () => {
    const { client, counts } = makePrismaForCount("profile-1", 3);

    await expect(countThirdPartyApplications(client, "user-1")).resolves.toBe(
      3,
    );
    expect(counts[0]).toEqual({
      where: {
        listing: ownedListingsFilter("profile-1"),
        applicantId: { not: "profile-1" },
      },
    });
  });

  /**
   * Every status, on purpose — and the one line where this can quietly break.
   *
   * This figure is what the erasure email tells the person is being kept for
   * somebody else. Restricting it to the recruiting statuses would report zero
   * for an account whose only third-party applications had been rejected: the
   * account that kept the most of other people's words would be told it kept
   * nothing.
   */
  it("asks for no status filter at all, unlike the deletion guard", async () => {
    const { client, counts } = makePrismaForCount("profile-1", 1);

    await countThirdPartyApplications(client, "user-1");

    const where = (counts[0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty("status");
    expect(where.listing).toEqual(ownedListingsFilter("profile-1"));
  });
});
