import { describe, expect, it } from "bun:test";
import { GoneException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma.service";
import { AccountDeletionService } from "./account-deletion.service";

type Scenario = {
  verification?: {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
  } | null;
  user?: { id: string; email: string } | null;
};

function makeService(scenario: Scenario) {
  const calls: string[] = [];
  const tx = {
    verification: {
      findFirst: async () => scenario.verification ?? null,
      delete: async () => {
        calls.push("verification.delete");
        return {};
      },
      deleteMany: async () => {
        calls.push("verification.deleteMany");
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => scenario.user ?? null,
      delete: async () => {
        calls.push("user.delete");
        return {};
      },
    },
    dataDeletionRequest: {
      updateMany: async () => {
        calls.push("dataDeletionRequest.updateMany");
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (run: (transaction: typeof tx) => Promise<void>) =>
      run(tx),
  } as unknown as PrismaService;

  return { service: new AccountDeletionService(prisma), calls };
}

describe("AccountDeletionService", () => {
  it("deletes the user, purges verification rows and marks the request executed", async () => {
    const { service, calls } = makeService({
      verification: {
        id: "v1",
        identifier: "delete-account-abc",
        value: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: { id: "user-1", email: "user@example.com" },
    });

    await service.confirmDeletion("abc");

    expect(calls).toEqual([
      "dataDeletionRequest.updateMany",
      "user.delete",
      "verification.deleteMany",
    ]);
  });

  it("rejects an unknown or already used token with 404", async () => {
    const { service } = makeService({ verification: null });

    await expect(service.confirmDeletion("unknown")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects an expired token with 410 and consumes it", async () => {
    const { service, calls } = makeService({
      verification: {
        id: "v1",
        identifier: "delete-account-expired",
        value: "user-1",
        expiresAt: new Date(Date.now() - 1_000),
      },
      user: { id: "user-1", email: "user@example.com" },
    });

    await expect(service.confirmDeletion("expired")).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(calls).toEqual(["verification.delete"]);
  });

  it("rejects with 410 when the account is already deleted", async () => {
    const { service, calls } = makeService({
      verification: {
        id: "v1",
        identifier: "delete-account-abc",
        value: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: null,
    });

    await expect(service.confirmDeletion("abc")).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(calls).toEqual(["verification.delete"]);
  });

  it("trims the token before lookup", async () => {
    const seen: unknown[] = [];
    const prisma = {
      $transaction: async (
        fn: (tx: {
          verification: { findFirst: (args: unknown) => Promise<null> };
        }) => Promise<void>,
      ) =>
        fn({
          verification: {
            findFirst: async (args: unknown) => {
              seen.push(args);
              return null;
            },
          },
        }),
    } as unknown as PrismaService;
    const service = new AccountDeletionService(prisma);

    await expect(service.confirmDeletion("  abc  ")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(JSON.stringify(seen[0])).toContain("delete-account-abc");
    expect(JSON.stringify(seen[0])).not.toContain("  abc  ");
  });
});
