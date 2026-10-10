import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import { SYSTEM_SCAFFOLD } from "./system-scaffold";
import { SystemScaffoldService } from "./system-scaffold.service";

/**
 * A client that behaves like a database for the three rows involved: it holds
 * them, refuses duplicates the way `createMany` with `skipDuplicates` does, and
 * counts what it actually inserted.
 *
 * The count is the point. `upsert` cannot tell "already there" from "created", so
 * a service built on it cannot say whether anything happened — and the whole value
 * of re-asserting on boot is knowing whether it was needed.
 */
/**
 * Captures what the service logs, so the assertions can be on the output rather
 * than on the absence of a throw. The service writes to `console.error` only.
 */
function captureConsoleError() {
  const original = console.error;
  let output = "";

  console.error = (...args: unknown[]) => {
    output += `${args.join(" ")}\n`;
  };

  return {
    output: () => output,
    restore: () => {
      console.error = original;
    },
  };
}

function makePrisma(existing: {
  user?: boolean;
  profile?: boolean;
  practice?: boolean;
}) {
  const rows = new Set<string>();
  if (existing.user) rows.add("user");
  if (existing.profile) rows.add("profile");
  if (existing.practice) rows.add("practice");

  const inserts: Record<string, unknown> = {};

  const client = {
    user: {
      createMany: async ({ data }: { data: unknown[] }) => {
        inserts.user = data[0];
        return { count: rows.has("user") ? 0 : (rows.add("user"), 1) };
      },
    },
    profile: {
      createMany: async ({ data }: { data: unknown[] }) => {
        inserts.profile = data[0];
        return { count: rows.has("profile") ? 0 : (rows.add("profile"), 1) };
      },
    },
    practice: {
      createMany: async ({ data }: { data: unknown[] }) => {
        inserts.practice = data[0];
        return { count: rows.has("practice") ? 0 : (rows.add("practice"), 1) };
      },
    },
  };

  return { prisma: client as unknown as PrismaService, rows, inserts };
}

describe("SystemScaffoldService", () => {
  it("recreates the scaffold when a database has none of it", async () => {
    // A dump taken before the migration, or a hand-deleted row. The next erasure of
    // an account whose listing carries somebody else's application would otherwise
    // fail with a 503 that names nothing.
    const { prisma, rows } = makePrisma({});

    await new SystemScaffoldService(prisma).onApplicationBootstrap();

    expect(rows.has("user")).toBe(true);
    expect(rows.has("profile")).toBe(true);
    expect(rows.has("practice")).toBe(true);
  });

  it("does nothing when the scaffold is already there", async () => {
    // Every boot of a healthy deployment. A warning here would be permanent, which
    // is how a warning stops being read.
    const { prisma } = makePrisma({
      user: true,
      profile: true,
      practice: true,
    });

    await expect(
      new SystemScaffoldService(prisma).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it("fills a partial scaffold rather than assuming", async () => {
    const { prisma, rows, inserts } = makePrisma({
      user: true,
      profile: true,
      practice: false,
    });

    await new SystemScaffoldService(prisma).onApplicationBootstrap();

    expect(rows.has("practice")).toBe(true);
    expect(inserts.practice).toBeDefined();
  });

  it("writes the fixed ids the erasure path looks up", async () => {
    const { prisma, inserts } = makePrisma({});

    await new SystemScaffoldService(prisma).onApplicationBootstrap();

    expect(inserts.user).toMatchObject({ id: SYSTEM_SCAFFOLD.userId });
    expect(inserts.profile).toMatchObject({
      id: SYSTEM_SCAFFOLD.profileId,
      userId: SYSTEM_SCAFFOLD.userId,
    });
    expect(inserts.practice).toMatchObject({
      id: SYSTEM_SCAFFOLD.practiceId,
      ownerId: SYSTEM_SCAFFOLD.profileId,
    });
  });

  it("leaves deletedAt null, so the sweep never collects the system row", async () => {
    // The purge matches on that column. A scaffold row with `deletedAt` set would be
    // a candidate for being dropped, and the applications parked on it would go
    // with it.
    const { prisma, inserts } = makePrisma({});

    await new SystemScaffoldService(prisma).onApplicationBootstrap();

    expect(inserts.user).not.toHaveProperty("deletedAt");
  });

  it("never fails the boot when the database is unreachable", async () => {
    // An API that can answer every route not involving an erasure should not be
    // taken down by a bookkeeping repair. The erasure path already refuses loudly
    // with the error that names the cause.
    const prisma = {
      user: {
        createMany: async () => {
          throw new Error("the database is not reachable");
        },
      },
    } as unknown as PrismaService;

    await expect(
      new SystemScaffoldService(prisma).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it("logs the driver code when the failure carries an empty message", async () => {
    // The shape Prisma actually throws on a refused connection, reproduced from a
    // real boot: `message` is a bare `Invalid ... invocation` header and the
    // diagnostic is in `code`. A mock raising a filled-in `Error` cannot catch a
    // regression in what gets logged, because it never reproduces the case that
    // produced a line naming nothing at all.
    const lines = captureConsoleError();
    const prisma = {
      user: {
        createMany: async () => {
          throw Object.assign(
            new Error("\nInvalid `prisma.user.createMany()` invocation:\n\n\n"),
            { code: "ECONNREFUSED", meta: { modelName: "User" } },
          );
        },
      },
    } as unknown as PrismaService;

    await new SystemScaffoldService(prisma).onApplicationBootstrap();
    lines.restore();

    const entry = JSON.parse(lines.output());
    expect(entry.message).toBe("system_scaffold.ensure_failed");
    expect(entry.error).toContain("ECONNREFUSED");
    expect(entry.error).toContain("prisma.user.createMany()");
  });

  it("does not log a credential carried by the driver's meta", async () => {
    const lines = captureConsoleError();
    const prisma = {
      user: {
        createMany: async () => {
          throw Object.assign(new Error("Can't reach database server"), {
            code: "P1001",
            meta: {
              databaseUrl:
                "postgresql://johndoe:randompassword@localhost:5432/mydb",
            },
          });
        },
      },
    } as unknown as PrismaService;

    await new SystemScaffoldService(prisma).onApplicationBootstrap();
    lines.restore();

    expect(lines.output()).not.toContain("randompassword");
  });
});
