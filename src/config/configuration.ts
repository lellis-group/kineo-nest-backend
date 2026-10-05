import { z } from "zod";

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return positiveInteger(value, 0, name);
}

/**
 * Parses a duration expressed either as plain seconds ("604800") or with a
 * suffix like "15m", "1h", "7d". Returns seconds.
 * Throws on invalid format instead of silently falling back, so a typo in
 * SESSION_EXPIRES_IN / SESSION_UPDATE_AGE fails fast at boot.
 */
export function durationSeconds(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error(
        `Invalid duration (must be a positive integer in seconds or a suffixed duration like "15m"): ${raw}`,
      );
    }
    return seconds;
  }
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${raw}": expected seconds ("604800") or a suffixed duration ("15m", "1h", "7d")`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1 / 1000,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid duration "${raw}": value must be positive`);
  }
  const seconds = value * multipliers[unit];
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid duration "${raw}": value must be positive`);
  }
  return seconds;
}

function configuration() {
  return {
    // ---- Env ----
    nodeEnv: process.env.NODE_ENV || "development",

    // ---- Server ----
    port: positiveInteger(process.env.PORT, 3000, "PORT"),

    // ---- CORS ----
    cors: {
      origins: (process.env.TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      credentials: true,
    },

    trustProxy: process.env.TRUST_PROXY === "true",

    // ---- Account erasure ----
    // The delay between anonymizing an account and dropping its row for good.
    accountPurgeGraceDays: positiveInteger(
      process.env.ACCOUNT_PURGE_GRACE_DAYS,
      30,
      "ACCOUNT_PURGE_GRACE_DAYS",
    ),
    // How long the executed trail is kept: it is the only proof the erasure
    // happened, and it holds no identifier.
    dataDeletionRequestRetentionDays: positiveInteger(
      process.env.DATA_DELETION_REQUEST_RETENTION_DAYS,
      365,
      "DATA_DELETION_REQUEST_RETENTION_DAYS",
    ),
    pendingDeletionRequestRetentionDays: positiveInteger(
      process.env.PENDING_DELETION_REQUEST_RETENTION_DAYS,
      30,
      "PENDING_DELETION_REQUEST_RETENTION_DAYS",
    ),

    // ---- Throttler (NestJS ThrottlerModule) ----
    throttle: {
      short: {
        ttl: positiveInteger(
          process.env.THROTTLE_SHORT_TTL,
          1_000,
          "THROTTLE_SHORT_TTL",
        ),
        limit: positiveInteger(
          process.env.THROTTLE_SHORT_LIMIT,
          5,
          "THROTTLE_SHORT_LIMIT",
        ),
      },
      medium: {
        ttl: positiveInteger(
          process.env.THROTTLE_MEDIUM_TTL,
          10_000,
          "THROTTLE_MEDIUM_TTL",
        ),
        limit: positiveInteger(
          process.env.THROTTLE_MEDIUM_LIMIT,
          30,
          "THROTTLE_MEDIUM_LIMIT",
        ),
      },
      deletion: {
        ttl: positiveInteger(
          process.env.THROTTLE_DELETION_TTL,
          900_000,
          "THROTTLE_DELETION_TTL",
        ),
        limit: positiveInteger(
          process.env.THROTTLE_DELETION_LIMIT,
          5,
          "THROTTLE_DELETION_LIMIT",
        ),
      },
      long: {
        ttl: positiveInteger(
          process.env.THROTTLE_LONG_TTL,
          60_000,
          "THROTTLE_LONG_TTL",
        ),
        limit: positiveInteger(
          process.env.THROTTLE_LONG_LIMIT,
          150,
          "THROTTLE_LONG_LIMIT",
        ),
      },
    },

    // ---- Rate limiting (better-auth internal, separate from ThrottlerModule) ----
    rateLimit: {
      window: positiveInteger(
        process.env.RATE_LIMIT_WINDOW,
        60,
        "RATE_LIMIT_WINDOW",
      ),
      max: positiveInteger(process.env.RATE_LIMIT_MAX, 20, "RATE_LIMIT_MAX"),
    },

    // better-auth applies its own, much tighter rule to the credential
    // endpoints and ignores rateLimit.max for them: 3 attempts per 10 seconds,
    // which locks out everyone behind a shared egress IP.
    credentialRateLimit: {
      window: positiveInteger(
        process.env.CREDENTIAL_RATE_LIMIT_WINDOW,
        10,
        "CREDENTIAL_RATE_LIMIT_WINDOW",
      ),
      max: positiveInteger(
        process.env.CREDENTIAL_RATE_LIMIT_MAX,
        3,
        "CREDENTIAL_RATE_LIMIT_MAX",
      ),
    },

    // ---- Session (better-auth) ----
    session: {
      expiresIn: durationSeconds(
        process.env.SESSION_EXPIRES_IN,
        60 * 60 * 24 * 7, // 7 days
      ),
      updateAge: durationSeconds(
        process.env.SESSION_UPDATE_AGE,
        60 * 60 * 24, // 1 day
      ),
      cookieCache: {
        enabled: process.env.COOKIE_CACHE_ENABLED !== "false",
        maxAge: positiveInteger(
          process.env.COOKIE_CACHE_MAX_AGE,
          300,
          "COOKIE_CACHE_MAX_AGE",
        ),
      },
    },

    // ---- JWT (better-auth, optional) ----
    jwt: {
      enabled: process.env.JWT_ENABLED === "true",
      expirationTime: process.env.JWT_EXPIRATION_TIME || "15m",
      rotationIntervalSeconds: process.env.JWT_ROTATION_INTERVAL
        ? Number(process.env.JWT_ROTATION_INTERVAL)
        : undefined,
    },

    // ---- Email (SMTP / nodemailer) ----
    smtp: {
      host: process.env.SMTP_HOST || "localhost",
      port: positiveInteger(process.env.SMTP_PORT, 1025, "SMTP_PORT"),
      secure: process.env.SMTP_SECURE === "true",
      from: process.env.SMTP_FROM || "noreply@localhost",
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASS || undefined,
    },

    // ---- Auth ----
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3001",
    betterAuthUrl: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    auth: {
      secret: process.env.BETTER_AUTH_SECRET,
    },

    // ---- Business constraints (quotas) ----
    // Undefined = unlimited. Keys must match the `limits.*` lookups in the
    // domain services (practices, replacementlistings, applications).
    limits: {
      practicesPerProfile: optionalPositiveInteger(
        process.env.MAX_PRACTICES_PER_PROFILE,
        "MAX_PRACTICES_PER_PROFILE",
      ),
      activeListingsPerProfile: optionalPositiveInteger(
        process.env.MAX_ACTIVE_LISTINGS_PER_PROFILE,
        "MAX_ACTIVE_LISTINGS_PER_PROFILE",
      ),
      activeApplicationsPerProfile: optionalPositiveInteger(
        process.env.MAX_ACTIVE_APPLICATIONS_PER_PROFILE,
        "MAX_ACTIVE_APPLICATIONS_PER_PROFILE",
      ),
    },

    // ---- Database (mirrors validated DATABASE_URL for DI consumers) ----
    databaseUrl: (process.env.DATABASE_URL ?? "").trim(),

    // ---- Swagger (can be overridden via env if needed) ----
    swagger: {
      title: "Kineo API",
      description: "Kineo API documentation",
      version: "1.0",
      tag: "Kineo",
    },
  };
}

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

// ============================================================
// Environment variable validation schema (Zod).
// Used by ConfigModule.forRoot({ validationSchema }) to validate that all
// required environment variables are present and correctly typed at startup.
//
// Required variables (no .default()) cause bootstrap to fail if missing/invalid.
// ============================================================

const BoolEnum = z.enum(["true", "false"]);
const NodeEnvEnum = z.enum(["development", "production", "test", "provision"]);

/** Accepts plain seconds ("604800") or a suffixed duration ("15m", "1h"). */
const DurationString = z.string().refine(
  (raw) => {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isSafeInteger(n) && n > 0;
    }
    return /^(\d+)\s*(ms|s|m|h|d|w)$/i.test(trimmed);
  },
  {
    message:
      'expected seconds ("604800") or a suffixed duration ("15m", "1h", "7d")',
  },
);

export const envValidationSchema = z
  .object({
    // ---- Critical (required, no fallback) ----
    BETTER_AUTH_SECRET: z.string().min(1),
    DATABASE_URL: z.string().min(1),

    // ---- Server ----
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    NODE_ENV: NodeEnvEnum.default("development"),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

    // ---- CORS / Frontend ----
    TRUSTED_ORIGINS: z
      .string()
      .default("")
      .refine(
        (raw) =>
          raw
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
            .every((origin) => {
              try {
                new URL(origin);
                return true;
              } catch {
                return false;
              }
            }),
        { message: "TRUSTED_ORIGINS must be a comma-separated list of URLs" },
      ),
    FRONTEND_URL: z.string().url().default("http://localhost:3001"),

    // ---- Proxy ----
    TRUST_PROXY: BoolEnum.default("false"),

    // ---- Throttler (NestJS ThrottlerModule) ----
    THROTTLE_SHORT_LIMIT: z.coerce.number().int().positive().default(5),
    THROTTLE_MEDIUM_LIMIT: z.coerce.number().int().positive().default(30),
    THROTTLE_LONG_LIMIT: z.coerce.number().int().positive().default(150),

    // ---- Rate limiting (better-auth) ----
    RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

    // ---- Session (better-auth) ----
    SESSION_EXPIRES_IN: DurationString.default("604800"),
    SESSION_UPDATE_AGE: DurationString.default("86400"),
    COOKIE_CACHE_ENABLED: BoolEnum.default("true"),
    COOKIE_CACHE_MAX_AGE: z.coerce.number().int().positive().default(300),

    // ---- JWT (better-auth, optional) ----
    JWT_ENABLED: BoolEnum.default("false"),
    JWT_EXPIRATION_TIME: DurationString.default("15m"),
    JWT_ROTATION_INTERVAL: z.coerce.number().int().positive().optional(),

    // ---- Email SMTP ----
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(1025),
    SMTP_SECURE: BoolEnum.default("false"),
    SMTP_FROM: z.string().default("noreply@localhost"),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    // ---- OAuth providers (reserved for future use) ----
    // @todo Remove or implement when OAuth auth is enabled
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // ---- External email provider (reserved for future use) ----
    // @todo Remove or implement when Resend is enabled
    RESEND_API_KEY: z.string().optional(),

    // ---- Business constraints ----
    MAX_PRACTICES_PER_PROFILE: z.coerce.number().int().positive().optional(),
    MAX_ACTIVE_LISTINGS_PER_PROFILE: z.coerce
      .number()
      .int()
      .positive()
      .optional(),
    MAX_ACTIVE_APPLICATIONS_PER_PROFILE: z.coerce
      .number()
      .int()
      .positive()
      .optional(),

    // ---- Data lifecycle ----
    DATA_DELETION_REQUEST_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .optional(),

    // ---- Auth ----
    REQUIRE_EMAIL_VERIFICATION: BoolEnum.default("false"),
  })
  .superRefine((env, ctx) => {
    // SMTP auth is all-or-nothing: a user without password (or vice versa)
    // would silently fall back to an unauthenticated transporter.
    if (
      (env.SMTP_USER && !env.SMTP_PASS) ||
      (!env.SMTP_USER && env.SMTP_PASS)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "SMTP_USER and SMTP_PASS must be set together",
        path: ["SMTP_USER"],
      });
    }
  })
  .passthrough(); // ignores unexpected process.env variables (PATH, HOME, etc.)
