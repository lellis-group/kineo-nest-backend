import { describe, expect, it } from "bun:test";
import { DEFAULT_NODE_ENV, isHardenedEnv } from "../../config/env";
import {
  type ConfigGetter,
  createAuth,
  createStandaloneAuth,
  readAuthEnv,
  readAuthEnvFromConfig,
} from "./index";

const REQUIRED_ENV = { BETTER_AUTH_SECRET: "s".repeat(64) };

/**
 * A ConfigService double over the keys configuration() actually publishes, which
 * are not the names of AuthEnv's fields: `auth.secret`, not `secret`.
 */
function configWith(values: Record<string, unknown> = {}): ConfigGetter {
  const published: Record<string, unknown> = {
    auth: { secret: "s".repeat(64) },
    betterAuthUrl: "http://kineo.test",
    frontendUrl: "http://kineo.test",
    cors: { origins: ["http://kineo.test"] },
    ...values,
  };

  return {
    get: <T>(key: string, fallback?: T) => {
      const found = key
        .split(".")
        .reduce<unknown>(
          (accumulator, part) =>
            accumulator === undefined || accumulator === null
              ? undefined
              : (accumulator as Record<string, unknown>)[part],
          published,
        );
      return (found === undefined ? fallback : found) as T;
    },
  };
}

describe("readAuthEnv", () => {
  it("refuses to build an auth without a secret", () => {
    expect(() => readAuthEnv({})).toThrow("BETTER_AUTH_SECRET is not set");
    expect(() => readAuthEnv({ BETTER_AUTH_SECRET: "" })).toThrow(
      "BETTER_AUTH_SECRET is not set",
    );
  });

  it("defaults the base URL rather than rejecting it", () => {
    expect(readAuthEnv(REQUIRED_ENV).baseUrl).toBe("http://localhost:3000");
    expect(
      readAuthEnv({ ...REQUIRED_ENV, BETTER_AUTH_URL: "http://kineo.test" })
        .baseUrl,
    ).toBe("http://kineo.test");
  });

  it("splits trusted origins and drops the blanks", () => {
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        TRUSTED_ORIGINS: "http://a.test, ,http://b.test",
      }).trustedOrigins,
    ).toEqual(["http://a.test", "http://b.test"]);
  });

  it("splits the trusted proxy list and drops the blanks, on both paths", () => {
    const env = readAuthEnv({
      ...REQUIRED_ENV,
      TRUST_PROXY_IPS: "10.0.0.0/8, ,192.0.2.10",
    });

    expect(env.trustedProxyIps).toEqual(["10.0.0.0/8", "192.0.2.10"]);
    expect(readAuthEnv({ ...REQUIRED_ENV }).trustedProxyIps).toEqual([]);
    expect(
      readAuthEnvFromConfig(
        configWith({ trustProxyIps: ["10.0.0.0/8", "192.0.2.10"] }),
      ).trustedProxyIps,
    ).toEqual(["10.0.0.0/8", "192.0.2.10"]);
    expect(readAuthEnvFromConfig(configWith()).trustedProxyIps).toEqual([]);
  });

  it("reads the shared-redis URL, on both paths, and nothing else when blank", () => {
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        REDIS_URL: " redis://cache.internal:6379 ",
      }).redisUrl,
    ).toBe("redis://cache.internal:6379");
    expect(readAuthEnv({ ...REQUIRED_ENV }).redisUrl).toBeUndefined();
    expect(
      readAuthEnvFromConfig(
        configWith({ redisUrl: "redis://cache.internal:6379" }),
      ).redisUrl,
    ).toBe("redis://cache.internal:6379");
    expect(readAuthEnvFromConfig(configWith()).redisUrl).toBeUndefined();
  });

  it("reads durations with a suffix", () => {
    const env = readAuthEnv({
      ...REQUIRED_ENV,
      SESSION_EXPIRES_IN: "15m",
      SESSION_UPDATE_AGE: "2d",
    });

    expect(env.sessionExpiresIn).toBe(900);
    expect(env.sessionUpdateAge).toBe(172_800);
  });

  it("throws on a duration it cannot parse, rather than falling back", () => {
    expect(() =>
      readAuthEnv({ ...REQUIRED_ENV, SESSION_EXPIRES_IN: "forever" }),
    ).toThrow(/Invalid duration/);
  });

  it("throws on a rate limit that is not a positive integer", () => {
    expect(() => readAuthEnv({ ...REQUIRED_ENV, RATE_LIMIT_MAX: "0" })).toThrow(
      /RATE_LIMIT_MAX/,
    );
    expect(() =>
      readAuthEnv({ ...REQUIRED_ENV, RATE_LIMIT_MAX: "many" }),
    ).toThrow(/RATE_LIMIT_MAX/);
  });

  it("reads the credential limits, which better-auth does not expose", () => {
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        CREDENTIAL_RATE_LIMIT_WINDOW: "60",
        CREDENTIAL_RATE_LIMIT_MAX: "10",
      }),
    ).toMatchObject({
      credentialRateLimitWindow: 60,
      credentialRateLimitMax: 10,
    });
  });

  it("defaults the address-change limit to what the two-step flow costs", () => {
    // Pinned because it is a decision, not an oversight: an address change sends
    // emails and needs two rounds of them, so the credential-tight 3/10s would
    // lock out a user who mistypes and corrects.
    expect(readAuthEnv({ ...REQUIRED_ENV }).changeEmailRateLimitMax).toBe(10);
    expect(readAuthEnv({ ...REQUIRED_ENV }).changeEmailRateLimitWindow).toBe(
      900,
    );
  });

  it("reads the erasure horizons the confirmation email quotes", () => {
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        ACCOUNT_PURGE_GRACE_DAYS: "14",
        DATA_DELETION_REQUEST_RETENTION_DAYS: "90",
      }),
    ).toMatchObject({
      accountPurgeGraceDays: 14,
      deletionRequestRetentionDays: 90,
    });
  });

  it("requires a verified address by default outside development and test", () => {
    expect(
      readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: "production" })
        .requireEmailVerification,
    ).toBe(true);
    expect(readAuthEnv({ ...REQUIRED_ENV }).requireEmailVerification).toBe(
      true,
    );
    expect(
      readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: "development" })
        .requireEmailVerification,
    ).toBe(false);
    expect(
      readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: "test" })
        .requireEmailVerification,
    ).toBe(false);
  });

  it("still obeys an explicit REQUIRE_EMAIL_VERIFICATION", () => {
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        NODE_ENV: "production",
        REQUIRE_EMAIL_VERIFICATION: "false",
      }).requireEmailVerification,
    ).toBe(false);
    expect(
      readAuthEnv({
        ...REQUIRED_ENV,
        NODE_ENV: "development",
        REQUIRE_EMAIL_VERIFICATION: "true",
      }).requireEmailVerification,
    ).toBe(true);
  });

  it("leaves the session cookie cache off unless it is asked for, on both paths", () => {
    // On, better-auth bakes the session and the user row into a signed cookie
    // that only a `version` function invalidates, and none is registered — so an
    // anonymized row keeps being served from the cookie. The two env readers
    // disagreed about the default, and the standalone one armed that trap for
    // every script and every importer of `{ auth }`.
    expect(readAuthEnv({ ...REQUIRED_ENV }).cookieCacheEnabled).toBe(false);
    expect(
      readAuthEnv({ ...REQUIRED_ENV, COOKIE_CACHE_ENABLED: "true" })
        .cookieCacheEnabled,
    ).toBe(true);
    expect(readAuthEnvFromConfig(configWith()).cookieCacheEnabled).toBe(false);
    expect(
      readAuthEnvFromConfig(
        configWith({ session: { cookieCache: { enabled: true } } }),
      ).cookieCacheEnabled,
    ).toBe(true);
  });

  it("treats any NODE_ENV but development and test as hardened", () => {
    expect(readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: "test" }).nodeEnv).toBe(
      "test",
    );
    // Absent, the default is the hardened one: a deployment that never set
    // NODE_ENV — the Dockerfile does not — used to arrive in development, with
    // Swagger served and non-Secure cookies. Asserted so the default cannot be
    // loosened back.
    expect(readAuthEnv({ ...REQUIRED_ENV }).nodeEnv).toBe(DEFAULT_NODE_ENV);
    expect(isHardenedEnv(readAuthEnv({ ...REQUIRED_ENV }).nodeEnv)).toBe(true);
  });
});

describe("readAuthEnvFromConfig", () => {
  it("reads the validated configuration, on the keys it publishes", () => {
    const env = readAuthEnvFromConfig(
      configWith({
        rateLimit: { max: 40 },
        credentialRateLimit: { max: 9 },
        // cookieCache lives under session, as configuration() publishes it.
        session: { expiresIn: 900, cookieCache: { enabled: false } },
        accountPurgeGraceDays: 14,
        dataDeletionRequestRetentionDays: 90,
        nodeEnv: "staging",
      }),
    );

    expect(env).toMatchObject({
      secret: "s".repeat(64),
      rateLimitMax: 40,
      credentialRateLimitMax: 9,
      sessionExpiresIn: 900,
      cookieCacheEnabled: false,
      accountPurgeGraceDays: 14,
      deletionRequestRetentionDays: 90,
      nodeEnv: "staging",
    });
  });

  it("keeps the defaults for the keys the configuration does not publish", () => {
    const env = readAuthEnvFromConfig(configWith());

    expect(env.accountPurgeGraceDays).toBe(30);
    expect(env.deletionRequestRetentionDays).toBe(365);
    expect(env.requireEmailVerification).toBe(false);
    expect(env.jwtEnabled).toBe(false);
  });

  it("falls back to the process env when the secret is not published", () => {
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "from-process-env";

    try {
      const env = readAuthEnvFromConfig(configWith({ auth: {} }));

      expect(env.secret).toBe("from-process-env");
    } finally {
      if (previous === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = previous;
      }
    }
  });
});

describe("the auth reference plugin", () => {
  /**
   * A read of the options `createAuth` was handed, rather than of the intent.
   *
   * Better Auth mounts its own reference at `/api/auth/reference` from the
   * `openAPI()` plugin. That is a different surface from the NestJS documentation
   * `app.ts` keeps behind `isHardenedEnv`, so gating only the latter left the
   * auth endpoints documented in production.
   */
  function pluginIds(nodeEnv: string): string[] {
    const prismaStub = {
      $transaction: async () => [],
      user: { findUnique: async () => null },
    } as unknown as Parameters<typeof createAuth>[1];

    const instance = createAuth(
      readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: nodeEnv }),
      prismaStub,
    );
    // Every plugin here is an object carrying an `id`; a function-shaped one
    // would mean the shape changed and this read would be reading nothing.
    return (instance.options.plugins ?? []).map((plugin) => {
      if (typeof plugin !== "object" || plugin === null || !("id" in plugin)) {
        throw new Error(
          "a plugin carries no id: the options this reads have changed shape",
        );
      }
      return String(plugin.id);
    });
  }

  it("is absent once the environment is hardened", () => {
    expect(pluginIds("production")).not.toContain("open-api");
    expect(pluginIds("staging")).not.toContain("open-api");
    // An unset NODE_ENV now defaults to production, so this is the path a
    // deployment that never set it takes.
    expect(pluginIds(DEFAULT_NODE_ENV)).not.toContain("open-api");
  });

  it("is present in development and test, where it is wanted", () => {
    expect(pluginIds("development")).toContain("open-api");
    expect(pluginIds("test")).toContain("open-api");
  });

  it("keeps the other plugins either way", () => {
    for (const nodeEnv of ["production", "development"]) {
      const ids = pluginIds(nodeEnv);
      expect(ids.length).toBeGreaterThan(1);
      expect(ids).toContain("next-cookies");
      expect(ids).toContain("email-verification-status");
    }
  });
});

describe("the auth rate limit", () => {
  /**
   * A read of the rules `createAuth` was handed, rather than of the intent.
   *
   * `/api/auth/*` is mounted as Express middleware, so the Nest throttler never
   * sees those routes: better-auth's own limiter is the only thing standing in
   * front of them, and its global `max` does not reach them — only `customRules`
   * do. Naming each one here is what keeps that dependency from being dropped.
   */
  function customRules(): Record<string, unknown> {
    const prismaStub = {
      $transaction: async () => [],
      user: { findUnique: async () => null },
    } as unknown as Parameters<typeof createAuth>[1];

    return (
      createAuth(readAuthEnv(REQUIRED_ENV), prismaStub).options.rateLimit
        ?.customRules ?? {}
    );
  }

  it("names the credential routes better-auth limits on its own", () => {
    const rules = customRules();

    expect(Object.keys(rules)).toContain("/sign-in/email");
    expect(Object.keys(rules)).toContain("/sign-up/email");
    expect(Object.keys(rules)).toContain("/change-email");
  });
});

describe("the secure cookie flag", () => {
  function secureCookies(nodeEnv: string): boolean {
    const prismaStub = {} as unknown as Parameters<typeof createAuth>[1];

    return Boolean(
      createAuth(
        readAuthEnv({ ...REQUIRED_ENV, NODE_ENV: nodeEnv }),
        prismaStub,
      ).options.advanced?.useSecureCookies,
    );
  }

  it("is asked for once the environment is hardened", () => {
    expect(secureCookies("production")).toBe(true);
    expect(secureCookies("staging")).toBe(true);
    expect(secureCookies(DEFAULT_NODE_ENV)).toBe(true);
  });

  it("is not asked for in development and test, where there is no TLS", () => {
    expect(secureCookies("development")).toBe(false);
    expect(secureCookies("test")).toBe(false);
  });
});

describe("advanced.ipAddress.trustedProxies", () => {
  function trustedProxies(extraEnv: Record<string, string>): unknown {
    const prismaStub = {} as unknown as Parameters<typeof createAuth>[1];

    return createAuth(readAuthEnv({ ...REQUIRED_ENV, ...extraEnv }), prismaStub)
      .options.advanced?.ipAddress?.trustedProxies;
  }

  it("reaches better-auth when the deployment names its proxies", () => {
    expect(
      trustedProxies({ TRUST_PROXY_IPS: "10.0.0.0/8, 192.0.2.10" }),
    ).toEqual(["10.0.0.0/8", "192.0.2.10"]);
  });

  it("stays off otherwise, leaving better-auth's single-header default", () => {
    expect(trustedProxies({})).toBeUndefined();
  });
});

describe("the rate-limit custom storage", () => {
  function customStorage(extraEnv: Record<string, string>): unknown {
    const prismaStub = {} as unknown as Parameters<typeof createAuth>[1];

    return createAuth(readAuthEnv({ ...REQUIRED_ENV, ...extraEnv }), prismaStub)
      .options.rateLimit?.customStorage;
  }

  it("counts the buckets in Redis when REDIS_URL is set", () => {
    // Claimed here as an option-shaped fact; the counting itself (atomicity,
    // shared budgets, fail-open) is rate-limit-redis.spec.ts's business.
    expect(
      customStorage({ REDIS_URL: "redis://cache.internal:6379" }),
    ).toHaveProperty("consume");
  });

  it("stays in the process's memory when it is not", () => {
    // Development and CI run with no Redis; better-auth's own Map is then the
    // whole story, as it always has been.
    expect(customStorage({})).toBeUndefined();
  });
});

describe("createStandaloneAuth", () => {
  it("answers one instance from every caller instead of building on every ask", () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    // The path used to run at import, where a missing secret was a module-load
    // failure for everything with a helper to read; it now runs on ask, and the
    // ask still needs the secret — set the way a script that wants this sets it.
    process.env.BETTER_AUTH_SECRET = "s".repeat(64);
    const stub = {} as unknown as Parameters<typeof createAuth>[1];

    try {
      const first = createStandaloneAuth(stub);
      const second = createStandaloneAuth(stub);

      expect(second).toBe(first);
    } finally {
      process.env.BETTER_AUTH_SECRET = secret;
    }
  });
});
