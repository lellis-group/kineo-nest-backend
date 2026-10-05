import { APIError, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { jwt, openAPI } from "better-auth/plugins";
import { countThirdPartyApplications } from "../../common/application-guard";
import { durationSeconds } from "../../config/configuration";
import { DEFAULT_NODE_ENV, isHardenedEnv } from "../../config/env";
import {
  sendChangeEmailApprovalEmail,
  sendChangeEmailEmail,
  sendDeleteAccountEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
} from "../email";
import { buildFrontendAuthUrl } from "../email/links";
import { deletionHash, deletionPepper } from "../hash";
import { logError } from "../log";
import { createPrismaClient } from "../prisma";
import { emailVerificationStatusPlugin } from "./email-verification-status";
import { inputValidationHook } from "./input-validation";
import {
  decodeVerificationToken,
  isChangeEmailVerificationToken,
} from "./verification-token";

export interface AuthEnv {
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  rateLimitWindow: number;
  rateLimitMax: number;
  credentialRateLimitWindow: number;
  credentialRateLimitMax: number;
  changeEmailRateLimitWindow: number;
  changeEmailRateLimitMax: number;
  sessionExpiresIn: number;
  sessionUpdateAge: number;
  cookieCacheEnabled: boolean;
  cookieCacheMaxAge: number;
  jwtEnabled: boolean;
  jwtExpirationTime: string;
  jwtRotationInterval?: number;
  requireEmailVerification: boolean;
  accountPurgeGraceDays: number;
  deletionRequestRetentionDays: number;
  frontendUrl: string;
  nodeEnv: string;
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
    changeEmailRateLimitWindow: positiveInt(
      env.CHANGE_EMAIL_RATE_LIMIT_WINDOW,
      900,
      "CHANGE_EMAIL_RATE_LIMIT_WINDOW",
    ),
    changeEmailRateLimitMax: positiveInt(
      env.CHANGE_EMAIL_RATE_LIMIT_MAX,
      10,
      "CHANGE_EMAIL_RATE_LIMIT_MAX",
    ),
    sessionExpiresIn: durationSeconds(env.SESSION_EXPIRES_IN, 60 * 60 * 24 * 7),
    sessionUpdateAge: durationSeconds(env.SESSION_UPDATE_AGE, 60 * 60 * 24),
    cookieCacheEnabled: env.COOKIE_CACHE_ENABLED !== "false",
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
    frontendUrl: env.FRONTEND_URL || "http://localhost:3001",
    nodeEnv: env.NODE_ENV || DEFAULT_NODE_ENV,
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
    // ConfigModule validation guarantees BETTER_AUTH_SECRET; this covers
    // hand-rolled ConfigService doubles in unit tests.
    return readAuthEnv();
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
      config.get<number>("credentialRateLimit.window", 10) ?? 10,
    credentialRateLimitMax:
      config.get<number>("credentialRateLimit.max", 3) ?? 3,
    changeEmailRateLimitWindow:
      config.get<number>("changeEmailRateLimit.window", 900) ?? 900,
    changeEmailRateLimitMax:
      config.get<number>("changeEmailRateLimit.max", 10) ?? 10,
    sessionExpiresIn:
      config.get<number>("session.expiresIn", 60 * 60 * 24 * 7) ??
      60 * 60 * 24 * 7,
    sessionUpdateAge:
      config.get<number>("session.updateAge", 60 * 60 * 24) ?? 60 * 60 * 24,
    cookieCacheEnabled:
      config.get<boolean>("session.cookieCache.enabled", true) ?? true,
    cookieCacheMaxAge:
      config.get<number>("session.cookieCache.maxAge", 300) ?? 300,
    jwtEnabled: config.get<boolean>("jwt.enabled", false) ?? false,
    jwtExpirationTime: config.get<string>("jwt.expirationTime", "15m") ?? "15m",
    jwtRotationInterval: config.get<number | undefined>(
      "jwt.rotationIntervalSeconds",
    ),
    requireEmailVerification:
      config.get<boolean>("requireEmailVerification", false) ?? false,
    accountPurgeGraceDays:
      config.get<number>("accountPurgeGraceDays", 30) ?? 30,
    deletionRequestRetentionDays:
      config.get<number>("dataDeletionRequestRetentionDays", 365) ?? 365,
    frontendUrl,
    nodeEnv:
      config.get<string>("nodeEnv", DEFAULT_NODE_ENV) ?? DEFAULT_NODE_ENV,
  };
}

export function createAuth(
  authEnv: AuthEnv = readAuthEnv(),
  prismaClient?: ReturnType<typeof createPrismaClient>,
) {
  const prisma = prismaClient ?? createPrismaClient();
  const frontendUrl = authEnv.frontendUrl;

  return betterAuth({
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),

    plugins: [
      // Better Auth serves its own reference at `/api/auth/reference`, served by
      // the `openAPI()` plugin. That is a *different* surface from the NestJS
      // documentation, which `app.ts` already keeps behind `isHardenedEnv` — so
      // gating one and not the other left the auth endpoints documented in
      // production while the REST ones were not.
      //
      // Read at module scope, which is fine here and wrong everywhere else:
      // `NODE_ENV` does not change between the import and the request.
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
      // Email self-service (right to rectification, art. 16 GDPR), in the shape
      // better-auth documents it for added security: the current address approves
      // first, and only then is a verification sent to the new one.
      //
      // Both parties hold a key, so neither a stolen session (which can start the
      // change but not approve it) nor control of a throwaway address (which can
      // verify but not request) is enough on its own. Two clicks for the
      // legitimate account, which is the price.
      changeEmail: {
        enabled: true,

        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await sendChangeEmailApprovalEmail({
            email: user.email,
            name: user.name,
            newEmail,
            url: buildFrontendAuthUrl(
              url,
              "/verify-email",
              { email: user.email, flow: "change-email-approval" },
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
        // session, anonymizes instead of deleting, and records the trail.
        //
        // Two routes reach the delete phase from here without ever consulting
        // sendDeleteAccountVerification: `POST /delete-user` with a `token`
        // body field, and `GET /delete-user/callback?token=`. Both consume the
        // verification row this config mints, so the emailed link reaches a raw
        // cascade straight through the anonymization. beforeDelete refuses them
        // both, and AccountErasureBypassSuite is what keeps it that way.
        beforeDelete: async (user) => {
          throw new APIError("FORBIDDEN", {
            message:
              "Account erasure runs through the emailed confirmation link. Use the link sent to the account, or POST /account/confirm-deletion with its token.",
          });
        },

        sendDeleteAccountVerification: async ({ user, url }) => {
          // Counted before the email goes out, so the disclosure is about this
          // account rather than a generic paragraph.
          const thirdPartyApplications = await countThirdPartyApplications(
            prisma,
            user.id,
          );

          // Accountability trail (art. 5(2) GDPR): record the request before
          // any execution. Never blocks the deletion flow on a bookkeeping
          // failure — the hourly sweep keeps the process resilient.
          try {
            const pepper = deletionPepper();
            await prisma.dataDeletionRequest.create({
              data: {
                userIdHash: deletionHash(user.id, pepper),
                emailHash: deletionHash(user.email, pepper),
              },
            });
          } catch (error) {
            logError("account.deletion.request.audit_failed", error, {
              userId: user.id,
            });
          }

          await sendDeleteAccountEmail({
            email: user.email,
            name: user.name,
            url: buildFrontendAuthUrl(url, "/goodbye", undefined, frontendUrl),
            thirdPartyApplications,
            purgeGraceDays: authEnv.accountPurgeGraceDays,
            trailRetentionDays: authEnv.deletionRequestRetentionDays,
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
      // better-auth rate-limits a set of routes itself, at 3 attempts per 10
      // seconds, and rateLimit.max does not reach them: any prefix match on
      // /sign-in, /sign-up, /change-password or /change-email. They are only
      // configurable through customRules, which is why each one is named here —
      // leaving one out means a knob that does not exist.
      customRules: {
        "/sign-in/email": {
          window: authEnv.credentialRateLimitWindow,
          max: authEnv.credentialRateLimitMax,
        },
        "/sign-up/email": {
          window: authEnv.credentialRateLimitWindow,
          max: authEnv.credentialRateLimitMax,
        },
        "/change-email": {
          window: authEnv.changeEmailRateLimitWindow,
          max: authEnv.changeEmailRateLimitMax,
        },
      },
    },

    session: {
      expiresIn: authEnv.sessionExpiresIn,
      updateAge: authEnv.sessionUpdateAge,
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
      // This handler serves a sign-up, a re-send, and the second half of a
      // change of address; the token is what tells them apart. Sending the
      // sign-up template for the last one is what a user sees as "an account
      // creation email" arriving when they only changed their address.
      //
      // The first half — the approval the current address has to give — goes
      // through `sendChangeEmailConfirmation` above and never lands here.
      sendVerificationEmail: async ({ user, url, token }) => {
        const decoded = await decodeVerificationToken(token, authEnv.secret);

        if (
          decoded &&
          isChangeEmailVerificationToken(decoded) &&
          decoded.updateTo
        ) {
          // The confirmation goes to the new address, since that is what proves
          // the person asking for the change controls it.
          await sendChangeEmailEmail({
            email: user.email,
            name: user.name,
            url: buildFrontendAuthUrl(
              url,
              "/verify-email",
              { email: user.email, flow: "change-email" },
              frontendUrl,
            ),
          });

          return;
        }

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
