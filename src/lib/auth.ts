import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { jwt, openAPI } from "better-auth/plugins";
import { countThirdPartyApplications } from "../common/application-guard";
import { durationSeconds } from "../config/configuration";
import { isHardenedEnv } from "../config/env";
import { emailVerificationStatusPlugin } from "./auth/email-verification-status";
import { inputValidationHook } from "./auth/input-validation";
import {
  sendChangeEmailEmail,
  sendDeleteAccountEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
} from "./email";
import { buildFrontendAuthUrl } from "./email/links";
import { deletionHash } from "./hash";
import { createPrismaClient } from "./prisma";

export interface AuthEnv {
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  rateLimitWindow: number;
  rateLimitMax: number;
  credentialRateLimitWindow: number;
  credentialRateLimitMax: number;
  sessionExpiresIn: number;
  sessionUpdateAge: number;
  cookieCacheEnabled: boolean;
  cookieCacheMaxAge: number;
  jwtEnabled: boolean;
  jwtExpirationTime: string;
  jwtRotationInterval?: number;
  requireEmailVerification: boolean;
  frontendUrl: string;
  nodeEnv: string;
  deletionPepper: string;
  accountPurgeGraceDays: number;
  deletionRequestRetentionDays: number;
}

type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Single parsing point for the standalone (non-DI) path: scripts, tests,
 * or `import { auth }`. Mirrors `src/config/configuration.ts` semantics
 * (durations accept seconds or "15m"/"1h" suffixes, invalid values throw).
 */
export function readAuthEnv(env: EnvSource = process.env): AuthEnv {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  const baseUrl = env.BETTER_AUTH_URL || "http://localhost:3000";
  return {
    secret,
    baseUrl,
    trustedOrigins: (env.TRUSTED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimitWindow: positiveInt(
      env.RATE_LIMIT_WINDOW,
      60,
      "RATE_LIMIT_WINDOW",
    ),
    rateLimitMax: positiveInt(env.RATE_LIMIT_MAX, 20, "RATE_LIMIT_MAX"),
    credentialRateLimitWindow: positiveInt(
      env.CREDENTIAL_RATE_LIMIT_WINDOW,
      10,
      "CREDENTIAL_RATE_LIMIT_WINDOW",
    ),
    credentialRateLimitMax: positiveInt(
      env.CREDENTIAL_RATE_LIMIT_MAX,
      3,
      "CREDENTIAL_RATE_LIMIT_MAX",
    ),
    sessionExpiresIn: durationSeconds(env.SESSION_EXPIRES_IN, 60 * 60 * 24 * 7),
    sessionUpdateAge: durationSeconds(env.SESSION_UPDATE_AGE, 60 * 60 * 24),
    cookieCacheEnabled: env.COOKIE_CACHE_ENABLED === "true",
    cookieCacheMaxAge: positiveInt(
      env.COOKIE_CACHE_MAX_AGE,
      60 * 5,
      "COOKIE_CACHE_MAX_AGE",
    ),
    jwtEnabled: env.JWT_ENABLED === "true",
    jwtExpirationTime: env.JWT_EXPIRATION_TIME || "15m",
    jwtRotationInterval: env.JWT_ROTATION_INTERVAL
      ? positiveInt(env.JWT_ROTATION_INTERVAL, 0, "JWT_ROTATION_INTERVAL")
      : undefined,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION === "true",
    frontendUrl: env.FRONTEND_URL || "http://localhost:3001",
    nodeEnv: env.NODE_ENV || "production",
    deletionPepper: env.DELETION_PEPPER || secret,
    accountPurgeGraceDays: positiveInt(
      env.ACCOUNT_PURGE_GRACE_DAYS,
      30,
      "ACCOUNT_PURGE_GRACE_DAYS",
    ),
    deletionRequestRetentionDays: positiveInt(
      env.DATA_DELETION_REQUEST_RETENTION_DAYS,
      365,
      "DATA_DELETION_REQUEST_RETENTION_DAYS",
    ),
  };
}

/** Minimal structural view of ConfigService (avoids a Nest import in lib). */
export interface ConfigGetter {
  get<T>(key: string, fallback?: T): T | undefined;
}

/**
 * DI path: builds the same AuthEnv from the validated, typed application
 * config instead of re-reading `process.env` (single source of truth).
 */
export function readAuthEnvFromConfig(config: ConfigGetter): AuthEnv {
  const secret = config.get<string>("auth.secret");
  if (!secret) {
    // Throwing rather than falling back to `readAuthEnv()`: that path re-parses
    // raw, unvalidated `process.env` and builds a differently-defaulted auth
    // instance — a second source of truth that fails silently, which is the
    // same class of bug as the `@Throttle()` overrides this branch removed.
    // Unit tests supply the key through their ConfigService double.
    throw new Error(
      "auth.secret is missing from the validated configuration; BETTER_AUTH_SECRET is required",
    );
  }
  const frontendUrl =
    config.get<string>("frontendUrl", "http://localhost:3001") ??
    "http://localhost:3001";
  const baseUrl =
    config.get<string>("betterAuthUrl", "http://localhost:3000") ??
    "http://localhost:3000";
  return {
    secret,
    baseUrl,
    trustedOrigins: config.get<string[]>("cors.origins", []) ?? [],
    rateLimitWindow: config.get<number>("rateLimit.window", 60) ?? 60,
    rateLimitMax: config.get<number>("rateLimit.max", 20) ?? 20,
    credentialRateLimitWindow:
      config.get<number>("rateLimit.credentialWindow", 10) ?? 10,
    credentialRateLimitMax:
      config.get<number>("rateLimit.credentialMax", 3) ?? 3,
    sessionExpiresIn:
      config.get<number>("session.expiresIn", 60 * 60 * 24 * 7) ??
      60 * 60 * 24 * 7,
    sessionUpdateAge:
      config.get<number>("session.updateAge", 60 * 60 * 24) ?? 60 * 60 * 24,
    cookieCacheEnabled:
      config.get<boolean>("session.cookieCache.enabled", false) ?? false,
    cookieCacheMaxAge:
      config.get<number>("session.cookieCache.maxAge", 300) ?? 300,
    jwtEnabled: config.get<boolean>("jwt.enabled", false) ?? false,
    jwtExpirationTime: config.get<string>("jwt.expirationTime", "15m") ?? "15m",
    jwtRotationInterval: config.get<number | undefined>(
      "jwt.rotationIntervalSeconds",
    ),
    requireEmailVerification:
      config.get<boolean>("requireEmailVerification", false) ?? false,
    frontendUrl,
    nodeEnv: config.get<string>("nodeEnv", "production") ?? "production",
    deletionPepper: config.get<string>("deletionPepper", secret) ?? secret,
    accountPurgeGraceDays:
      config.get<number>("accountPurgeGraceDays", 30) ?? 30,
    deletionRequestRetentionDays:
      config.get<number>("dataDeletionRequestRetentionDays", 365) ?? 365,
  };
}

export function createAuth(
  authEnv: AuthEnv = readAuthEnv(),
  prismaClient?: ReturnType<typeof createPrismaClient>,
) {
  const prisma = prismaClient ?? createPrismaClient();
  const frontendUrl = authEnv.frontendUrl;
  const pepper = authEnv.deletionPepper;
  const accountPurgeGraceDays = authEnv.accountPurgeGraceDays;
  const deletionRequestRetentionDays = authEnv.deletionRequestRetentionDays;

  return betterAuth({
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),

    plugins: [
      ...(isHardenedEnv(authEnv.nodeEnv) ? [] : [openAPI()]),
      nextCookies(),
      emailVerificationStatusPlugin(),
      ...(authEnv.jwtEnabled
        ? [
            jwt({
              jwt: {
                expirationTime: authEnv.jwtExpirationTime,
                issuer: authEnv.baseUrl,
                audience: authEnv.baseUrl,
              },
              jwks: {
                rotationInterval: authEnv.jwtRotationInterval,
              },
            }),
          ]
        : []),
    ],

    user: {
      // Email self-service (right to rectification, art. 16 GDPR): the
      // confirmation email goes to the NEW address, so only someone controlling
      // it can apply the change.
      changeEmail: {
        enabled: true,

        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await sendChangeEmailEmail({
            email: newEmail,
            name: user.name,
            url: buildFrontendAuthUrl(
              url,
              "/verify-email",
              {
                email: newEmail,
              },
              frontendUrl,
            ),
          });
        },
      },

      deleteUser: {
        enabled: true,

        // The deletion verification token lives 24h in the `verification` table
        // (identifier: `delete-account-<token>`, value: user id).
        deleteTokenExpiresIn: 60 * 60 * 24,

        // Better-auth is limited to the REQUEST phase: mint the single-use token
        // and email the confirmation link (frontend `/goodbye`). The erasure
        // itself is done by `POST /account/confirm-deletion`
        // (AccountDeletionService): it consumes the token without requiring a
        // session, anonymizes the account, flips the audit trail
        // (DataDeletionRequest PENDING -> ANONYMIZED) and purges `verification`
        // leftovers, all in one transaction.
        sendDeleteAccountVerification: async ({ user, url }) => {
          // Accountability trail (art. 5(2) GDPR): record the request before any
          // execution, keyed by fingerprint so erasing the account does not
          // leave the email behind in an audit table.
          //
          // The previous pending request is superseded rather than duplicated:
          // a partial unique index allows only one PENDING row per user, so a
          // second request would otherwise fail the insert and silently erase
          // the trail of the first one.
          //
          // A failure here is deliberately not swallowed. Letting the email go
          // out without a trail row would produce an erasure that cannot be
          // accounted for, which is the exact situation art. 5(2) exists to
          // prevent.
          const userIdHash = deletionHash(user.id, pepper);

          await prisma.$transaction(async (tx) => {
            await tx.dataDeletionRequest.updateMany({
              where: { userIdHash, status: "PENDING" },
              data: { status: "SUPERSEDED" },
            });

            await tx.dataDeletionRequest.create({
              data: {
                userIdHash,
                emailHash: deletionHash(user.email, pepper),
              },
            });
          });

          await sendDeleteAccountEmail({
            email: user.email,
            name: user.name,
            url: buildFrontendAuthUrl(url, "/goodbye", undefined, frontendUrl),
            listingsUrl: `${frontendUrl}/listings/mine`,
            thirdPartyApplications: await countThirdPartyApplications(
              prisma,
              user.id,
            ),
            purgeGraceDays: accountPurgeGraceDays,
            trailRetentionDays: deletionRequestRetentionDays,
          });
        },

        // Blocks every remaining path to `internalAdapter.deleteUser`, which is
        // a raw cascade: `User -> Profile -> Practice -> ReplacementListing ->
        // Application`. Two routes reach it with nothing but the caller's own
        // session, and neither consults `sendDeleteAccountVerification`:
        // `POST /delete-user` with a `token` body field, and
        // `GET /delete-user/callback?token=`. Both consume the same
        // verification row this config mints, so the emailed link reaches the
        // hard delete directly. `POST /delete-user` without a token is already
        // safe: `sendDeleteAccountVerification` returns before this hook.
        //
        // Throwing here rather than setting `enabled: false` keeps the request
        // phase, which only exists inside the handler gated by that flag.
        beforeDelete: async () => {
          throw new APIError("BAD_REQUEST", {
            message:
              "Account deletion is handled by POST /account/confirm-deletion.",
            code: "DELETION_ROUTE_DISABLED",
          });
        },
      },
    },

    secret: authEnv.secret,

    baseURL: authEnv.baseUrl,

    trustedOrigins: authEnv.trustedOrigins,

    rateLimit: {
      enabled: true,
      window: authEnv.rateLimitWindow,
      max: authEnv.rateLimitMax,
      // Overrides better-auth's built-in 3-per-10s rule for the credential
      // endpoints, which its own `window`/`max` do not reach.
      customRules: {
        "/sign-in/*": {
          window: authEnv.credentialRateLimitWindow,
          max: authEnv.credentialRateLimitMax,
        },
        "/sign-up/*": {
          window: authEnv.credentialRateLimitWindow,
          max: authEnv.credentialRateLimitMax,
        },
      },
    },

    session: {
      expiresIn: authEnv.sessionExpiresIn,
      updateAge: authEnv.sessionUpdateAge,
      /**
       * Off by default, and the reason is not performance.
       *
       * The cache is served from a signed cookie that better-auth validates
       * without ever touching the database. Its `version` option cannot close
       * that hole: better-auth computes it from the *decoded cookie payload*
       * (`dist/api/routes/session.mjs`), so a function keyed on the user row
       * is compared against the very copy it was baked from and always
       * matches. Deleting the `Session` rows does not invalidate it either,
       * because `internalAdapter.findSession` is only reached on a cache miss.
       *
       * The concrete consequence was the account erasure: anonymization
       * overwrote `name`/`image`/`emailVerified` in the database, yet for
       * `cookieCache.maxAge` `get-session` kept answering from the cookie
       * with `emailVerified: true` — an erased identity that still passed
       * `EmailVerifiedGuard` and could write. `EmailVerifiedGuard` no longer
       * trusts the session payload (it re-reads the row), but anything else
       * reading the session would still be served stale data, so the cache
       * stays disabled until better-auth exposes a server-side invalidation
       * hook. See `email-verified.guard.ts`.
       */
      cookieCache: {
        enabled: authEnv.cookieCacheEnabled,
        maxAge: authEnv.cookieCacheMaxAge,
      },
    },

    advanced: {
      useSecureCookies: isHardenedEnv(authEnv.nodeEnv),
    },

    emailAndPassword: {
      enabled: true,

      requireEmailVerification: authEnv.requireEmailVerification,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,

      sendResetPassword: async ({ user, url }) => {
        await sendResetPasswordEmail({
          email: user.email,
          name: user.name,
          url: buildFrontendAuthUrl(
            url,
            "/reset-password",
            undefined,
            frontendUrl,
          ),
        });
      },
    },

    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail({
          email: user.email,
          name: user.name,
          url: buildFrontendAuthUrl(
            url,
            "/verify-email",
            { email: user.email },
            frontendUrl,
          ),
        });
      },

      autoSignInAfterVerification: true,
    },

    hooks: {
      before: inputValidationHook,
    },
  });
}

/**
 * Standalone instance for scripts/tests importing `{ auth }` directly.
 * The Nest application path builds its own instance from ConfigService
 * (see `AppModule`), so the validated config stays the single source of truth.
 */
export const auth = createAuth();

export type BetterAuthInstance = ReturnType<typeof createAuth>;
