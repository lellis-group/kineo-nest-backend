import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDisk, LocalDisk } from "@nestjs/storage";
import type { PrismaService } from "../prisma.service";
import { FilesLifecycleService } from "./files-lifecycle.service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FilesLifecycleService", () => {
  it("deletes the rows and the objects of an erased account", async () => {
    const disk = new InMemoryDisk();
    await disk.put("avatars/p-1/a.png", Buffer.from("a"));
    await disk.put("cv-profiles/p-1/c.pdf", Buffer.from("c"));

    const deletedIds: string[][] = [];
    const prisma = {
      profile: { findUnique: async () => ({ id: "p-1" }) },
      storedFile: {
        findMany: async () => [
          { id: "f-1", storageKey: "avatars/p-1/a.png" },
          { id: "f-2", storageKey: "cv-profiles/p-1/c.pdf" },
        ],
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          deletedIds.push(where.id.in);
          return { count: where.id.in.length };
        },
      },
    } as unknown as PrismaService;

    await new FilesLifecycleService(prisma, disk).eraseForUser("u-1");

    expect(deletedIds).toEqual([["f-1", "f-2"]]);
    expect(disk.keys().sort()).toEqual([]);
  });

  it("does nothing when the erased user has no profile", async () => {
    const disk = new InMemoryDisk();
    const prisma = {
      profile: { findUnique: async () => null },
    } as unknown as PrismaService;

    await new FilesLifecycleService(prisma, disk).eraseForUser("missing");
    expect(disk.keys()).toEqual([]);
  });

  it("sweeps only old objects that no row references", async () => {
    const root = await mkdtemp(join(tmpdir(), "kineo-files-sweep-"));
    directories.push(root);
    const disk = new LocalDisk({ root });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await disk.put("kept", Buffer.from("k"));
    await disk.put("orphan", Buffer.from("o"));
    await disk.put("in-flight", Buffer.from("i"));
    await utimes(disk.path("kept"), old, old);
    await utimes(disk.path("orphan"), old, old);

    const prisma = {
      storedFile: {
        findMany: async () => [{ storageKey: "kept" }],
      },
    } as unknown as PrismaService;

    await new FilesLifecycleService(prisma, disk).sweepOrphanedObjects();

    expect(await disk.exists("kept")).toBe(true);
    expect(await disk.exists("in-flight")).toBe(true);
    expect(await disk.exists("orphan")).toBe(false);
  });
});
