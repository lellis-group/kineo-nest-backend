import { describe, expect, it } from "bun:test";
import type { Prisma } from "../generated/prisma/client";
import { recalcListingStatus } from "./listing-status";

/**
 * Minimal transaction double: the helper only reads the listing, counts its
 * active applications, and writes the status back when it moved.
 */
function makeTx(scenario: {
  listing?: { id: string; status: string; maxApplications?: number | null };
  activeCount?: number;
}) {
  const updates: { id: string; status: string }[] = [];

  const tx = {
    replacementListing: {
      findUnique: async () => scenario.listing ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string };
      }) => {
        updates.push({ id: where.id, status: data.status });
        return {};
      },
    },
    application: {
      count: async () => scenario.activeCount ?? 0,
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, updates };
}

describe("recalcListingStatus", () => {
  it("reopens a listing left with no active candidate", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "IN_DISCUSSION" },
      activeCount: 0,
    });

    await recalcListingStatus(tx, "l1");

    expect(updates).toEqual([{ id: "l1", status: "OPEN" }]);
  });

  it("marks a listing full once it reaches its cap", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "OPEN", maxApplications: 2 },
      activeCount: 2,
    });

    await recalcListingStatus(tx, "l1");

    expect(updates).toEqual([{ id: "l1", status: "FULL" }]);
  });

  it("keeps an uncapped listing under discussion", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "OPEN", maxApplications: null },
      activeCount: 7,
    });

    await recalcListingStatus(tx, "l1");

    expect(updates).toEqual([{ id: "l1", status: "IN_DISCUSSION" }]);
  });

  it("writes nothing when the status is already right", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "OPEN" },
      activeCount: 0,
    });

    await recalcListingStatus(tx, "l1");

    expect(updates).toEqual([]);
  });

  it("ignores a listing that no longer exists", async () => {
    const { tx, updates } = makeTx({});

    await recalcListingStatus(tx, "gone");

    expect(updates).toEqual([]);
  });

  it("leaves a filled listing alone by default", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "FILLED" },
      activeCount: 0,
    });

    await recalcListingStatus(tx, "l1");

    expect(updates).toEqual([]);
  });

  it("recomputes a filled listing when explicitly allowed", async () => {
    const { tx, updates } = makeTx({
      listing: { id: "l1", status: "FILLED" },
      activeCount: 0,
    });

    await recalcListingStatus(tx, "l1", { includeFilled: true });

    expect(updates).toEqual([{ id: "l1", status: "OPEN" }]);
  });

  it("never reopens a listing its owner took out of circulation", async () => {
    for (const status of ["CLOSED", "CANCELLED"]) {
      const { tx, updates } = makeTx({
        listing: { id: "l1", status },
        activeCount: 0,
      });

      await recalcListingStatus(tx, "l1", { includeFilled: true });

      expect(updates).toEqual([]);
    }
  });
});
