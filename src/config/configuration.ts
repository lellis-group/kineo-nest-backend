import { z } from "zod";
import {
  MIN_PENDING_RETENTION_DAYS,
  PENDING_DELETION_REQUEST_RETENTION_DAYS,
} from "../data-lifecycle/data-lifecycle.service";
import { MAX_BROWSE_MAP_PLACES } from "../replacementlistings/browse";
import { DEFAULT_NODE_ENV, envBoolean, isHardenedEnv } from "./env";

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

/**
 * The largest delay `@nestjs/throttler` can be asked to wait.
 *
 * It arms a `setTimeout` with the value, and Node clamps any delay past
 * `2^31-1` ms to **1 ms**. A `THROTTLE_LONG_TTL` of 30 days is a plausible thing
 * to type, and it would not slow the tier down: it would run it on every request.
 * So the ceiling is refused rather than accepted and quietly inverted.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long an unconfirmed erasure request is kept, with a floor.
 *
 * The floor is the point. The confirmation link is valid for 24 hours, so a
 * one-day horizon sweeps the `PENDING` row while its own link is still live — and
 * every later confirmation then finds no request, refuses, and that account can
 * never be erased by that link. Two days is the shortest horizon that cannot
 * outrun the token it belongs to.
 */
function pendingRequestRetentionDays(): number {
  const days = positiveInteger(
    process.env.PENDING_DELETION_REQUEST_RETENTION_DAYS,
    PENDING_DELETION_REQUEST_RETENTION_DAYS,
    "PENDING_DELETION_REQUEST_RETENTION_DAYS",
  );

  if (days < MIN_PENDING_RETENTION_DAYS) {
    throw new Error(
      `PENDING_DELETION_REQUEST_RETENTION_DAYS must be at least ${MIN_PENDING_RETENTION_DAYS}, got: ${days}`,
    );
  }
  return days;
}

/** A timer value, bounded on both ends: 1 ms to `MAX_TIMER_MS`. */
function timerMs(value: string | undefined, fallback: number, name: string) {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed > MAX_TIMER_MS) {
    throw new Error(
      `${name} must be an integer between 1 and ${MAX_TIMER_MS} ms, got: ${parsed}`,
    );
  }
  return parsed;
}

/**
 * One entry of the trusted-proxy list, as better-auth's `trustedProxies` takes
 * it: an IPv4 or IPv6 address, or an equivalent CIDR range.
 */
const proxyEntrySchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

/**
 * Whether the proxy is trusted, and whether the environment decided that.
 *
 * Trusting it is the right default for an application designed to run behind one,
 * so the value stays. What changes is that a deployment which is *not* behind one
 * and forgot to say so can now be told: with the proxy trusted and none present,
 * `req.ip` is whatever the caller put in `X-Forwarded-For`, and the throttler key
 * with it.
 */
function readTrustProxy(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  implied: boolean;
} {
  const raw = env.TRUST_PROXY?.trim();

  if (raw === undefined || raw === "") {
    return { enabled: isHardenedEnv(env.NODE_ENV), implied: true };
  }

  return { enabled: envBoolean(raw, false), implied: false };
}

function configuration() {
  const trustProxy = readTrustProxy(process.env);

  return {
    // ---- Env ----
    nodeEnv: process.env.NODE_ENV || DEFAULT_NODE_ENV,

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

    // Unset means "believe the proxy", and only where that is safe: this app is
    // designed behind a proxy (a separate frontend origin), so trusting nothing by
    // default made `req.ip` the proxy for every caller, and the throttler and every
    // IP control then saw the whole platform as one client. Development has no
    // proxy to trust, and trusting one there hides real client addresses.
    trustProxy: trustProxy.enabled,
    trustProxyImplied: trustProxy.implied,
    // The addresses or CIDR ranges of the proxies themselves: TRUST_PROXY says
    // that a proxy is there, this says which one. better-auth walks the
    // forwarded-for chain right to left, skips these hops, and takes the first
    // untrusted address as the client IP — for its rate-limit keys and the
    // session rows alike. The same list is handed to Express as its `trust
    // proxy` setting, so the throttler's `req.ip` resolves the same client.
    // Unset keeps better-auth's default, which trusts only a single-value chain
    // and answers nothing on a two-hop one (CDN plus load balancer), collapsing
    // every such caller into one shared rate-limit bucket. See the comment on
    // advanced.ipAddress in lib/auth.
    trustProxyIps: (process.env.TRUST_PROXY_IPS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),

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
    pendingDeletionRequestRetentionDays: pendingRequestRetentionDays(),

    // ---- Throttler (NestJS ThrottlerModule) ----
    throttle: {
      short: {
        ttl: timerMs(
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
        ttl: timerMs(
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
        ttl: timerMs(
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
        ttl: timerMs(
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
    // Same story for the address change: better-auth rate-limits /change-email
    // on its own and rateLimit.max does not reach it.
    // Ten attempts per quarter of an hour. Deliberately looser than the
    // credential limit: this endpoint fires emails, and the shipped flow needs
    // two of them before anything is applied. Three per ten seconds was chosen
    // when a change went out in a single message, and it is tight enough to lock
    // out a legitimate user who mistypes and corrects.
    changeEmailRateLimit: {
      window: positiveInteger(
        process.env.CHANGE_EMAIL_RATE_LIMIT_WINDOW,
        900,
        "CHANGE_EMAIL_RATE_LIMIT_WINDOW",
      ),
      max: positiveInteger(
        process.env.CHANGE_EMAIL_RATE_LIMIT_MAX,
        10,
        "CHANGE_EMAIL_RATE_LIMIT_MAX",
      ),
    },

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
      // Off unless it is asked for, which is the reverse of what it was.
      //
      // The cache bakes the whole session *and user* row into a signed cookie
      // (`cookies/index.mjs:77`), and the only thing that invalidates it is its
      // `version` field, which better-auth fixes at "1" unless a `version`
      // function is registered (`cookies/index.mjs:80-86`). Nothing here changes
      // it, so a row that was anonymized, un-verified or re-verified keeps being
      // served from the cookie until it expires.
      //
      // Turning it on therefore means also registering a `version` that moves when
      // the row does — which is why the knob is opt-in rather than opt-out.
      cookieCache: {
        enabled: process.env.COOKIE_CACHE_ENABLED === "true",
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

    // ---- Shared throttle storage (optional) ----
    // Unset means the throttler counts in memory, which is per process: N replicas
    // then allow N times the configured budget.
    redisUrl: (process.env.REDIS_URL ?? "").trim() || undefined,

    // ---- Health ----
    // Unset means there is no deep probe: `/health` answers liveness only.
    health: {
      deepToken: (process.env.HEALTH_DEEP_TOKEN ?? "").trim() || undefined,
    },

    // ---- Auth ----
    // Unset means a verified address is required outside development and test.
    // better-auth gates the approval half of a change of address on the session's
    // address already being verified, so with this off nothing ever reaches that
    // gate and the new address is emailed directly.
    requireEmailVerification: envBoolean(
      process.env.REQUIRE_EMAIL_VERIFICATION,
      isHardenedEnv(process.env.NODE_ENV),
    ),
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

    // ---- Browse feed ----
    // How many distinct practices the /listings map is drawn from. A guard on
    // the payload, not a product quota, which is why it does not live in
    // `limits.*`: that block is documented as "undefined = unlimited", and an
    // unbounded map is the one outcome this endpoint exists to prevent. It is
    // tunable because the collection grows; `truncated` in the response is
    // what lets the client adapt to whatever it is set to.
    browse: {
      mapPlaces: positiveInteger(
        process.env.MAX_BROWSE_MAP_PLACES,
        MAX_BROWSE_MAP_PLACES,
        "MAX_BROWSE_MAP_PLACES",
      ),
    },

    // ---- Database (mirrors validated DATABASE_URL for DI consumers) ----
    databaseUrl: (process.env.DATABASE_URL ?? "").trim(),
    // Prisma's own client logger, off by default. It is here rather than read
    // from the environment at the point of use so that it is validated, typed and
    // visible in the configuration like every other switch; `lib/prisma.ts` keeps
    // the same rule for the clients built outside Nest.
    prismaLogQueries: envBoolean(process.env.PRISMA_LOG_QUERIES, false),

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

// ============================================================
// Environment variable validation schema (Zod).
// Used by ConfigModule.forRoot({ validationSchema }) to validate that all
// required environment variables are present and correctly typed at startup.
//
// Required variables (no .default()) cause bootstrap to fail if missing/invalid.
// ============================================================

const BoolEnum = z.enum(["true", "false"]);
const NodeEnvEnum = z.enum(["development", "production", "test", "provision"]);

/** A `@nestjs/throttler` window: 1 ms to Node's own timer ceiling. */
/**
 * A `@nestjs/throttler` window: 1 ms to Node's own timer ceiling.
 *
 * Optional, because these four are unset in every normal deployment and the
 * factory carries the defaults — and `z.coerce.number()` on an absent variable
 * yields `NaN`, not `undefined`, so without this the schema would reject a
 * perfectly ordinary configuration at boot.
 */
const TimerMsSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_TIMER_MS)
  .optional();

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
    // 32 characters is the floor better-auth's own guidance sets for a secret it
    // signs with, and four characters is not a secret.
    BETTER_AUTH_SECRET: z.string().min(32),
    DATABASE_URL: z.string().min(1),

    // ---- Server ----
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    NODE_ENV: NodeEnvEnum.default(DEFAULT_NODE_ENV),
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
    // No default: the factory decides between the environment and the hardened
    // one, and a default here would replace that with a flat "false".
    TRUST_PROXY: BoolEnum.optional(),
    // Comma-separated addresses or CIDR ranges of the reverse proxies
    // themselves. Each entry has to be an IP, a v4 or v6 CIDR range, or
    // nothing at all: better-auth refuses an entry it cannot parse with a
    // warning at request time, and a typo would silently leave every caller in
    // one shared rate-limit bucket. Refusing it here turns the typo into a
    // boot failure instead.
    TRUST_PROXY_IPS: z
      .string()
      .default("")
      .refine(
        (raw) =>
          raw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .every((entry) => proxyEntrySchema.safeParse(entry).success),
        {
          message:
            "TRUST_PROXY_IPS must be a comma-separated list of IP addresses or CIDR ranges (IPv4 or IPv6)",
        },
      ),

    // ---- Throttler (NestJS ThrottlerModule) ----
    // The TTLs were absent from this schema altogether, so a typo in one of them
    // passed validation and was then rejected by the factory with a message about
    // a different file. Bounded like the factory bounds them.
    THROTTLE_SHORT_TTL: TimerMsSchema,
    THROTTLE_MEDIUM_TTL: TimerMsSchema,
    THROTTLE_LONG_TTL: TimerMsSchema,
    THROTTLE_DELETION_TTL: TimerMsSchema,
    THROTTLE_SHORT_LIMIT: z.coerce.number().int().positive().default(5),
    THROTTLE_MEDIUM_LIMIT: z.coerce.number().int().positive().default(30),
    THROTTLE_LONG_LIMIT: z.coerce.number().int().positive().default(150),

    // ---- Rate limiting (better-auth) ----
    RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

    // ---- Session (better-auth) ----
    SESSION_EXPIRES_IN: DurationString.default("604800"),
    SESSION_UPDATE_AGE: DurationString.default("86400"),
    COOKIE_CACHE_ENABLED: BoolEnum.optional(),
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
    MAX_BROWSE_MAP_PLACES: z.coerce.number().int().positive().optional(),

    // ---- Data lifecycle ----
    DATA_DELETION_REQUEST_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .optional(),

    // ---- Auth ----
    // No default: the factory decides between the environment and the hardened
    // one, and a default here would replace that with a flat "false".
    REQUIRE_EMAIL_VERIFICATION: BoolEnum.optional(),

    // Unset means the throttler counts in memory, per process.
    REDIS_URL: z.string().url().optional(),

    // Unset means there is no deep health probe.
    HEALTH_DEEP_TOKEN: z.string().min(16).optional(),
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
