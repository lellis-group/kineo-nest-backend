import { describe, expect, it } from "bun:test";
import configuration, { envValidationSchema } from "./configuration";
import { DEFAULT_NODE_ENV, isHardenedEnv } from "./env";

describe("isHardenedEnv", () => {
  it("treats development and test as non-hardened", () => {
    expect(isHardenedEnv("development")).toBe(false);
    expect(isHardenedEnv("test")).toBe(false);
  });

  it("treats anything else as hardened", () => {
    expect(isHardenedEnv("production")).toBe(true);
    expect(isHardenedEnv("staging")).toBe(true);
    expect(isHardenedEnv("PRODUCTION")).toBe(true);
    expect(isHardenedEnv("prod ")).toBe(true);
  });

  it("defaults to hardened when the value is missing or blank", () => {
    expect(isHardenedEnv()).toBe(true);
    expect(isHardenedEnv(null)).toBe(true);
    expect(isHardenedEnv("")).toBe(true);
    expect(isHardenedEnv("   ")).toBe(true);
  });
});

describe("DEFAULT_NODE_ENV", () => {
  it("is the value the configuration reaches when NODE_ENV is unset", () => {
    // The factory, its validation schema and both branches of the auth env reader
    // all default to this. A deployment that never sets NODE_ENV — the Dockerfile
    // does not — takes this path, so it has to be the hardened one rather than
    // a value that merely looks like one.
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      expect(configuration().nodeEnv).toBe(DEFAULT_NODE_ENV);
      expect(isHardenedEnv(configuration().nodeEnv)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it("still lets an explicit development or test through", () => {
    const previous = process.env.NODE_ENV;

    try {
      for (const value of ["development", "test"]) {
        process.env.NODE_ENV = value;
        expect(configuration().nodeEnv).toBe(value);
        expect(isHardenedEnv(configuration().nodeEnv)).toBe(false);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});

/** Runs `body` with `patch` applied to the environment, then restores it. */
function withEnv<T>(
  patch: Record<string, string | undefined>,
  body: () => T,
): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("gates close by default", () => {
  it("trusts the proxy by default outside development, and not in it", () => {
    // With a separate frontend origin, this app is designed behind a proxy.
    // Trusting nothing made `req.ip` the proxy for every caller, and the
    // throttler and every IP control then saw the whole platform as one client.
    withEnv({ TRUST_PROXY: undefined, NODE_ENV: "production" }, () => {
      expect(configuration().trustProxy).toBe(true);
    });
    withEnv({ TRUST_PROXY: undefined, NODE_ENV: "staging" }, () => {
      expect(configuration().trustProxy).toBe(true);
    });
    withEnv({ TRUST_PROXY: undefined, NODE_ENV: "development" }, () => {
      expect(configuration().trustProxy).toBe(false);
    });
    withEnv({ TRUST_PROXY: undefined, NODE_ENV: "test" }, () => {
      expect(configuration().trustProxy).toBe(false);
    });
  });

  it("still obeys TRUST_PROXY when it is set", () => {
    withEnv({ TRUST_PROXY: "false", NODE_ENV: "production" }, () => {
      expect(configuration().trustProxy).toBe(false);
    });
    withEnv({ TRUST_PROXY: "true", NODE_ENV: "development" }, () => {
      expect(configuration().trustProxy).toBe(true);
    });
  });

  it("leaves the cookie cache off unless it is asked for", () => {
    // On, it bakes the user row into a signed cookie that only a `version`
    // function invalidates, and none is registered.
    withEnv({ COOKIE_CACHE_ENABLED: undefined }, () => {
      expect(configuration().session.cookieCache.enabled).toBe(false);
    });
    withEnv({ COOKIE_CACHE_ENABLED: "true" }, () => {
      expect(configuration().session.cookieCache.enabled).toBe(true);
    });
  });

  it("refuses a throttle window past Node's timer ceiling", () => {
    // Node clamps a delay above 2^31-1 ms to 1 ms, so an accepted 30-day window
    // would run the tier on every request instead of slowing it down.
    expect(() =>
      withEnv({ THROTTLE_LONG_TTL: String(2_147_483_648) }, () =>
        configuration(),
      ),
    ).toThrow(/THROTTLE_LONG_TTL/);

    expect(
      withEnv(
        { THROTTLE_LONG_TTL: String(2_147_483_647) },
        () => configuration().throttle.long.ttl,
      ),
    ).toBe(2_147_483_647);
  });

  it("refuses a secret too short to be one", () => {
    // Four characters used to pass, and this secret signs sessions and derives
    // the erasure trail's fingerprints.
    const secret = envValidationSchema.shape.BETTER_AUTH_SECRET;

    expect(secret.safeParse("s".repeat(31)).success).toBe(false);
    expect(secret.safeParse("").success).toBe(false);
    expect(secret.safeParse("s".repeat(32)).success).toBe(true);
  });

  it("validates an environment with no throttle window set", () => {
    // The windows are unset in every ordinary deployment and the factory holds
    // the defaults. `z.coerce.number()` turns an absent variable into NaN rather
    // than undefined, so an unbounded schema here would refuse to boot.
    const parsed = envValidationSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "s".repeat(64),
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a throttle window past the ceiling through the schema too", () => {
    const parsed = envValidationSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "s".repeat(64),
      THROTTLE_LONG_TTL: String(2_147_483_648),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("the pending erasure horizon has a floor", () => {
  /**
   * The confirmation link lives 24 hours. A shorter horizon sweeps the pending row
   * while its own link is still usable, and every confirmation after that finds no
   * request and refuses — so the account can never be erased by that link, and the
   * only way out is to ask again.
   */
  function retentionFor(value: string | undefined) {
    return withEnv(
      { PENDING_DELETION_REQUEST_RETENTION_DAYS: value },
      () => configuration().pendingDeletionRequestRetentionDays,
    );
  }

  it("defaults to thirty days", () => {
    expect(retentionFor(undefined)).toBe(30);
  });

  it("accepts the shortest horizon that cannot outrun its own link", () => {
    expect(retentionFor("2")).toBe(2);
    expect(retentionFor("90")).toBe(90);
  });

  it("refuses a horizon shorter than the link it belongs to", () => {
    expect(() => retentionFor("1")).toThrow(/PENDING_DELETION_REQUEST/);
    expect(() => retentionFor("0")).toThrow(/PENDING_DELETION_REQUEST/);
  });
});
