import { describe, expect, it } from "bun:test";
import { type ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../../prisma.service";
import { EmailVerifiedGuard } from "./email-verified.guard";

function makeGuard({
  method = "POST",
  userId = "user-1",
  user,
  requireEmailVerification = true,
}: {
  method?: string;
  userId?: string | undefined;
  user?: { emailVerified: boolean } | null;
  requireEmailVerification?: boolean;
} = {}) {
  const prisma = {
    user: {
      findUnique: async () => user ?? null,
    },
  } as unknown as PrismaService;

  const config = {
    get: (key: string, fallback?: boolean) =>
      key === "requireEmailVerification" ? requireEmailVerification : fallback,
  } as unknown as ConfigService;

  const guard = new EmailVerifiedGuard(prisma, config);

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method, session: { user: { id: userId } } }),
    }),
  } as unknown as ExecutionContext;

  return { guard, context };
}

describe("EmailVerifiedGuard", () => {
  it("lets reads through, whatever the verification state", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const { guard, context } = makeGuard({
        method,
        user: { emailVerified: false },
      });

      expect(await guard.canActivate(context)).toBe(true);
    }
  });

  it("gates every write method, not only POST", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { guard, context } = makeGuard({
        method,
        user: { emailVerified: false },
      });

      expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it("refuses a write when the account is gone, whatever the session says", async () => {
    const { guard, context } = makeGuard({ user: null });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses a write without a session", async () => {
    const { guard, context } = makeGuard({ userId: undefined });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("honours the flag being off, so an unverified account can still write", async () => {
    const { guard, context } = makeGuard({
      user: { emailVerified: false },
      requireEmailVerification: false,
    });

    expect(await guard.canActivate(context)).toBe(true);
  });
});
