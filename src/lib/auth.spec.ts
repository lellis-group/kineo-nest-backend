import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import { type AuthEnv, createAuth, readAuthEnv } from "./auth";
import { createPrismaClient } from "./prisma";

/**
 * The session cookie cache is served from a signed cookie without ever reading
 * the database, and better-auth recomputes its `version` from the decoded
 * payload — so a version hook cannot notice a change made in the database.
 * These tests pin the mitigation that does work: the cache stays off unless it
 * is explicitly turned on.
 */

const baseEnv: AuthEnv = {
  baseUrl: "http://localhost:3000",
  secret: "s".repeat(32),
  trustedOrigins: ["http://localhost:3001"],
  sessionExpiresIn: 604800,
  sessionUpdateAge: 86400,
  rateLimitWindow: 60,
  rateLimitMax: 20,
  cookieCacheEnabled: false,
  cookieCacheMaxAge: 300,
  jwtEnabled: false,
  requireEmailVerification: false,
  frontendUrl: "http://localhost:3001",
  nodeEnv: "development",
  deletionPepper: "p".repeat(32),
  accountPurgeGraceDays: 30,
  deletionRequestRetentionDays: 365,
};

/** Reach into the resolved better-auth options without a live backend. */
function cookieCacheOptions(env: Partial<AuthEnv> = {}) {
  const prisma = {
    user: { findUnique: async () => null },
    session: { findUnique: async () => null, deleteMany: async () => ({}) },
    account: { findUnique: async () => null },
  } as unknown as PrismaService;

  const auth = createAuth(
    { ...baseEnv, ...env },
    prisma as unknown as ReturnType<typeof createPrismaClient>,
  ) as unknown as {
    options: {
      session: {
        cookieCache: {
          enabled?: boolean;
          version?: unknown;
        };
      };
    };
  };

  return auth.options.session.cookieCache;
}

describe("session cookie cache", () => {
  it("is disabled by default", () => {
    // The cache cannot be invalidated server-side, so it must not be on
    // unless someone deliberately opted in. A revoked session that still
    // authenticates is the failure this prevents.
    expect(cookieCacheOptions().enabled).toBe(false);
  });

  it("is off when COOKIE_CACHE_ENABLED is unset", () => {
    const env = readAuthEnv({
      BETTER_AUTH_SECRET: "s".repeat(32),
      DATABASE_URL: "postgresql://localhost/kineo",
    } as unknown as NodeJS.ProcessEnv);

    expect(env.cookieCacheEnabled).toBe(false);
  });

  it("can still be enabled explicitly", () => {
    // Opt-in stays available; it is just no longer the default.
    expect(cookieCacheOptions({ cookieCacheEnabled: true }).enabled).toBe(true);
  });

  it("registers no version hook", () => {
    // A `version` function looks like it invalidates the cache on a user-row
    // change. It does not: better-auth calls it with the cached payload
    // (`dist/api/routes/session.mjs`), so the value it returns is compared
    // against the copy it was baked from and always matches.
    expect(cookieCacheOptions().version).toBeUndefined();
  });
});
