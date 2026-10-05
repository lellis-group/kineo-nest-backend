import { describe, expect, it } from "bun:test";
import { type ConfigGetter, readAuthEnv, readAuthEnvFromConfig } from "./index";

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
    expect(readAuthEnv({ ...REQUIRED_ENV }).nodeEnv).toBe("development");
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
