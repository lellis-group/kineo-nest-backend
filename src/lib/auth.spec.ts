import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import { createAuth, type AuthEnv } from "./auth";

/**
 * The session cookie cache is served from a signed cookie without ever
 * touching the database, so deleting the `Session` rows does not invalidate it.
 * These tests pin the version hook that closes that window.
 */

const baseEnv: AuthEnv = {
  baseUrl: "http://localhost:3000",
  secret: "s".repeat(32),
  trustedOrigins: ["http://localhost:3001"],
  sessionExpiresIn: 604800,
  sessionUpdateAge: 86400,
  rateLimitWindow: 60,
  rateLimitMax: 20,
  cookieCacheEnabled: true,
  cookieCacheMaxAge: 300,
  emailVerification: { requireEmailVerification: false },
  advanced: { useSecureCookies: false },
  jwtEnabled: false,
  requireEmailVerification: false,
  frontendUrl: "http://localhost:3001",
  nodeEnv: "development",
  deletionPepper: "p".repeat(32),
  accountPurgeGraceDays: 30,
  deletionRequestRetentionDays: 365,
};

/** Reach into the resolved better-auth options without a live backend. */
function sessionOptions(env: Partial<AuthEnv> = {}) {
  const prisma = {
    user: { findUnique: async () => null },
    session: { findUnique: async () => null, deleteMany: async () => ({}) },
    account: { findUnique: async () => null },
  } as unknown as PrismaService;

  const auth = createAuth(
    { ...baseEnv, ...env } as AuthEnv,
    prisma as unknown as ReturnType<typeof createPrismaClient>,
  ) as unknown as {
    options: { session: { cookieCache: { version: (s: unknown, u: unknown) => string } } };
  };

  return auth.options.session.cookieCache;
}

describe("session cookie cache versioning", () => {
  it("changes when the user row is updated", () => {
    const { version } = sessionOptions();

    const before = version({}, { updatedAt: new Date("2026-01-01T00:00:00Z") });
    const after = version({}, { updatedAt: new Date("2026-01-02T00:00:00Z") });

    // Anonymization rewrites the user row, so the cached payload must no
    // longer match or `get-session` keeps serving the pre-erasure name.
    expect(before).not.toBe(after);
  });

  it("is stable for an unchanged user", () => {
    const { version } = sessionOptions();
    const updatedAt = new Date("2026-01-01T00:00:00Z");

    expect(version({}, { updatedAt })).toBe(version({}, { updatedAt }));
  });

  it("ignores the session argument", () => {
    const { version } = sessionOptions();
    const updatedAt = new Date("2026-01-01T00:00:00Z");

    expect(version({ id: "a" }, { updatedAt })).toBe(
      version({ id: "b" }, { updatedAt }),
    );
  });
});
