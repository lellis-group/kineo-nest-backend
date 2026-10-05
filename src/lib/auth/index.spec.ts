import { describe, expect, it } from "bun:test";
import { DEFAULT_NODE_ENV, isHardenedEnv } from "../../config/env";
import {
  type ConfigGetter,
  createAuth,
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
