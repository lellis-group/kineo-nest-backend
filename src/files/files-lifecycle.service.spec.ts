import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import { FilesLifecycleService } from "./files-lifecycle.service";
import type { FileStorage } from "./storage/file-storage";

function harness(
  storedFiles: Array<{ id: string; storageKey: string }> = [],
  objects: Array<{ key: string; lastModified: Date }> = [],
) {
  const removed: string[] = [];
  const deletedIds: string[][] = [];
  const storage = {
    remove: async (key: string) => {
      removed.push(key);
    },
    list: async () => objects,
  } as unknown as FileStorage;

  const prisma = {
    profile: {
      findUnique: async () => ({ id: "p-1" }),
    },
    storedFile: {
      findMany: async () => storedFiles,
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        deletedIds.push(where.id.in);
        return { count: where.id.in.length };
      },
    },
  } as unknown as PrismaService;

  const service = new FilesLifecycleService(prisma, storage);
  return { service, removed, deletedIds, storage };
}

describe("FilesLifecycleService", () => {
  it("deletes the rows and the objects of an erased account", async () => {
    const { service, removed, deletedIds } = harness([
      { id: "f-1", storageKey: "avatars/p-1/a.pdf" },
      { id: "f-2", storageKey: "cv-profiles/p-1/c.pdf" },
    ]);

    await service.eraseForUser("u-1");

    expect(deletedIds).toEqual([["f-1", "f-2"]]);
    expect(removed.sort()).toEqual([
      "avatars/p-1/a.pdf",
      "cv-profiles/p-1/c.pdf",
    ]);
  });

  it("does nothing when the erased user has no profile", async () => {
    const removed: string[] = [];
    const prisma = {
      profile: { findUnique: async () => null },
    } as unknown as PrismaService;
    const service = new FilesLifecycleService(prisma, {
      remove: async (key: string) => {
        removed.push(key);
      },
    } as unknown as FileStorage);

    await service.eraseForUser("missing");
    expect(removed).toEqual([]);
  });

  it("sweeps only old objects that no row references", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const fresh = new Date();
    const { service, removed } = harness(
      [{ id: "f-1", storageKey: "kept" }],
      [
        { key: "kept", lastModified: old },
        { key: "orphan", lastModified: old },
        { key: "in-flight", lastModified: fresh },
      ],
    );

    await service.sweepOrphanedObjects();

    expect(removed).toEqual(["orphan"]);
  });
});
