import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../../prisma.service";
import { EmailVerifiedGuard } from "./email-verified.guard";

type UserRow = { emailVerified: boolean; deletedAt: Date | null } | null;

function contextFor(method: string, session?: { user: { id: string } }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, session }),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(
  user: UserRow,
  requireEmailVerification: boolean,
): EmailVerifiedGuard {
  return new EmailVerifiedGuard(
    {
      user: { findUnique: async () => user },
    } as unknown as PrismaService,
    {
      get: <T>(key: string, fallback: T) =>
        (key === "requireEmailVerification"
          ? requireEmailVerification
          : fallback) as T,
    } as unknown as ConfigService,
  );
}

describe("EmailVerifiedGuard", () => {
  it("never gates a read", async () => {
    await expect(
      guardFor(null, true).canActivate(contextFor("GET", undefined)),
    ).resolves.toBe(true);
  });

  it("refuses a write with no session", async () => {
    await expect(
      guardFor({ emailVerified: true, deletedAt: null }, false).canActivate(
        contextFor("POST", undefined),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses an erased account even when verification is not required", async () => {
    // `deletedAt` is checked before the flag, so turning the requirement off
    // cannot hand a purged or anonymized account its writes back.
    await expect(
      guardFor(
        { emailVerified: false, deletedAt: new Date() },
        false,
      ).canActivate(contextFor("PATCH", { user: { id: "u1" } })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      guardFor(null, false).canActivate(
        contextFor("DELETE", { user: { id: "u1" } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an unverified account write while the requirement is off", async () => {
    // better-auth only sends a verification email on sign-up when the
    // requirement is on, so gating unconditionally refused every write under
    // the shipped default and no email had ever been sent to satisfy it.
    await expect(
      guardFor({ emailVerified: false, deletedAt: null }, false).canActivate(
        contextFor("POST", { user: { id: "u1" } }),
      ),
    ).resolves.toBe(true);
  });

  it("refuses an unverified account while the requirement is on", async () => {
    await expect(
      guardFor({ emailVerified: false, deletedAt: null }, true).canActivate(
        contextFor("POST", { user: { id: "u1" } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      guardFor({ emailVerified: true, deletedAt: null }, true).canActivate(
        contextFor("PUT", { user: { id: "u1" } }),
      ),
    ).resolves.toBe(true);
  });
});
