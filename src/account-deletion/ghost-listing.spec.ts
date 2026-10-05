import { describe, expect, it } from "bun:test";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import type { Prisma } from "../generated/prisma/client";
import {
  detachThirdPartyApplications,
  PRESERVED_APPLICATION_STATUSES,
  ServiceUnavailableScaffoldError,
} from "./ghost-listing";

function makePrisma(options: {
  scaffold?: boolean;
  existingGhost?: { id: string } | null;
  applications?: { id: string; listingId: string }[];
}) {
  const writes: Record<string, unknown> = {};

  const client = {
    practice: {
      findUnique: async () =>
        options.scaffold === false ? null : { id: SYSTEM_SCAFFOLD.practiceId },
    },
    application: {
      findMany: async (args: unknown) => {
        writes.findMany = args;
        return options.applications ?? [];
      },
      updateMany: async (args: unknown) => {
        writes.updateMany = args;
        return { count: (options.applications ?? []).length };
      },
    },
    replacementListing: {
      findFirst: async () => options.existingGhost ?? null,
      create: async (args: unknown) => {
        writes.create = args;
        return { id: "listing-ghost-new" };
      },
    },
  };

  return { client: client as never, writes };
}

const input = {
  ownerProfileId: "profile-owner",
  listingIds: ["listing-1", "listing-2"],
};

describe("detachThirdPartyApplications", () => {
  it("parks the other candidates' applications on a ghost listing", async () => {
    const { client, writes } = makePrisma({
      applications: [
        { id: "application-1", listingId: "listing-1" },
        { id: "application-2", listingId: "listing-2" },
      ],
    });

    const result = await detachThirdPartyApplications(client, input);

    expect(result.detachedApplications).toBe(2);
    expect(writes.updateMany).toEqual({
      where: { id: { in: ["application-1", "application-2"] } },
      data: { listingId: "listing-ghost-new" },
    });
    expect(writes.create).toMatchObject({
      data: {
        practiceId: SYSTEM_SCAFFOLD.practiceId,
        status: "CLOSED_NO_CANDIDATE",
      },
    });
  });

  it("never takes the erased account's own applications", async () => {
    const { client, writes } = makePrisma({
      applications: [{ id: "application-1", listingId: "listing-1" }],
    });

    await detachThirdPartyApplications(client, input);

    const where = (writes.findMany as { where: Prisma.ApplicationWhereInput })
      .where;
    expect(where.applicantId).toEqual({ not: "profile-owner" });
    expect(where.status).toEqual({ in: [...PRESERVED_APPLICATION_STATUSES] });
    expect(where.listingId).toEqual({ in: input.listingIds });
  });

  it("reuses an existing ghost instead of creating a second one", async () => {
    const { client, writes } = makePrisma({
      existingGhost: { id: "listing-ghost-old" },
      applications: [{ id: "application-1", listingId: "listing-1" }],
    });

    const result = await detachThirdPartyApplications(client, input);

    expect(result.ghostListingId).toBe("listing-ghost-old");
    expect(writes.create).toBeUndefined();
  });

  it("creates nothing when there is no third-party application", async () => {
    const { client, writes } = makePrisma({ applications: [] });

    const result = await detachThirdPartyApplications(client, input);

    expect(result).toEqual({ ghostListingId: "", detachedApplications: 0 });
    expect(writes.create).toBeUndefined();
    expect(writes.updateMany).toBeUndefined();
  });

  it("refuses rather than destroying the applications when the scaffold is missing", async () => {
    const { client } = makePrisma({
      scaffold: false,
      applications: [{ id: "application-1", listingId: "listing-1" }],
    });

    await expect(
      detachThirdPartyApplications(client, input),
    ).rejects.toBeInstanceOf(ServiceUnavailableScaffoldError);
  });
});
