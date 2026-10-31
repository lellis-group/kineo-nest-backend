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
      expect(configuration().trustProxyImplied).toBe(false);
    });
    withEnv({ TRUST_PROXY: "true", NODE_ENV: "development" }, () => {
      expect(configuration().trustProxy).toBe(true);
      expect(configuration().trustProxyImplied).toBe(false);
    });
  });

  it("says when trusting the proxy was its own decision", () => {
    // A deployment that is not behind a proxy and never set TRUST_PROXY then has
    // a client-controlled `req.ip`, and the throttler key with it. The boot log
    // is what separates that from a deliberate choice.
    withEnv({ TRUST_PROXY: undefined, NODE_ENV: "production" }, () => {
      expect(configuration().trustProxyImplied).toBe(true);
    });
    withEnv({ TRUST_PROXY: "", NODE_ENV: "production" }, () => {
      expect(configuration().trustProxyImplied).toBe(true);
    });
    withEnv({ TRUST_PROXY: "false", NODE_ENV: "production" }, () => {
      expect(configuration().trustProxyImplied).toBe(false);
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
    //
    // NODE_ENV is left unset on purpose: it defaults to the hardened one, which
    // now also means a pepper — that is the shape a bare production host boots
    // in.
    const parsed = envValidationSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "s".repeat(64),
      DELETION_PEPPER: "p".repeat(64),
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a throttle window past the ceiling through the schema too", () => {
    const parsed = envValidationSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "s".repeat(64),
      DELETION_PEPPER: "p".repeat(64),
      THROTTLE_LONG_TTL: String(2_147_483_648),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("the trusted proxy list", () => {
  const schema = envValidationSchema.shape.TRUST_PROXY_IPS;

  it("is empty by default, so a deployment behind one proxy needs none", () => {
    expect(schema.parse(undefined)).toBe("");
    expect(schema.parse("")).toBe("");
  });

  it("accepts the addresses and ranges better-auth walks by", () => {
    const proxyEntries = ["10.0.0.0/8", "192.0.2.10", "2001:db8::/32"].join(
      ",",
    );
    expect(schema.parse(proxyEntries)).toBe(proxyEntries);
  });

  it("refuses an entry better-auth would only warn about, once, at request time", () => {
    // A typo here has no second line of defence: better-auth ignores entries it
    // cannot parse and answers no client IP, which is the failure this list
    // exists to prevent. The schema makes it a boot failure instead.
    for (const raw of [
      "10.0.0.0/8, not-an-address",
      "300.0.0.1",
      "10.0.0.0/99",
      "example.com",
    ]) {
      expect(schema.safeParse(raw).success).toBe(false);
    }
  });

  it("shows up in the configuration as a list, blanks dropped", () => {
    withEnv({ TRUST_PROXY_IPS: "10.0.0.0/8, ,192.0.2.10" }, () => {
      expect(configuration().trustProxyIps).toEqual([
        "10.0.0.0/8",
        "192.0.2.10",
      ]);
    });
    withEnv({ TRUST_PROXY_IPS: undefined }, () => {
      expect(configuration().trustProxyIps).toEqual([]);
    });
  });
});

describe("the verified address requirement", () => {
  it("is required by default outside development and test", () => {
    withEnv(
      { REQUIRE_EMAIL_VERIFICATION: undefined, NODE_ENV: "production" },
      () => {
        expect(configuration().requireEmailVerification).toBe(true);
      },
    );
    withEnv(
      { REQUIRE_EMAIL_VERIFICATION: undefined, NODE_ENV: undefined },
      () => {
        expect(configuration().requireEmailVerification).toBe(true);
      },
    );
    withEnv(
      { REQUIRE_EMAIL_VERIFICATION: undefined, NODE_ENV: "development" },
      () => {
        expect(configuration().requireEmailVerification).toBe(false);
      },
    );
    withEnv({ REQUIRE_EMAIL_VERIFICATION: undefined, NODE_ENV: "test" }, () => {
      expect(configuration().requireEmailVerification).toBe(false);
    });
  });

  it("still obeys an explicit value", () => {
    withEnv(
      { REQUIRE_EMAIL_VERIFICATION: "false", NODE_ENV: "production" },
      () => {
        expect(configuration().requireEmailVerification).toBe(false);
      },
    );
    withEnv(
      { REQUIRE_EMAIL_VERIFICATION: "true", NODE_ENV: "development" },
      () => {
        expect(configuration().requireEmailVerification).toBe(true);
      },
    );
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

/**
 * Whether the parse refused for a *named* reason, rather than a wrong value
 * elsewhere in the environment — the helper the pepper and lifecycle-knob
 * suites share.
 */
function hasNamedIssue(
  parsed: {
    success: boolean;
    error?: { issues: { path: PropertyKey[] }[] };
  },
  key: PropertyKey,
) {
  return (
    !parsed.success &&
    (parsed.error?.issues ?? []).some((issue) => issue.path.includes(key))
  );
}

describe("the erasure pepper is required where it is needed", () => {
  /**
   * The pepper is what keeps an HMAC of an email from being reversible from the
   * same database's other tables, so a hardened environment is refused at boot
   * rather than at the first confirmation link. Development, test and CI keep
   * theirs optional: erasure is not reachable there by a real caller, and a
   * secret that cannot leave the deployer's control is better absent than
   * committed.
   *
   * `NODE_ENV` unset defaults to the hardened one, so the bare parse below is
   * the shape of a production host that never set it.
   */
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "s".repeat(64),
  };

  function hasPepperIssue(parsed: {
    success: boolean;
    error?: { issues: { path: PropertyKey[] }[] };
  }) {
    return hasNamedIssue(parsed, "DELETION_PEPPER");
  }

  it("refuses a hardened environment that has no pepper", () => {
    expect(hasPepperIssue(envValidationSchema.safeParse(base))).toBe(true);
    expect(
      hasPepperIssue(
        envValidationSchema.safeParse({ ...base, NODE_ENV: "production" }),
      ),
    ).toBe(true);
    expect(
      hasPepperIssue(
        envValidationSchema.safeParse({ ...base, NODE_ENV: "provision" }),
      ),
    ).toBe(true);
  });

  it("accepts a hardened environment that has one", () => {
    expect(
      envValidationSchema.safeParse({
        ...base,
        DELETION_PEPPER: "p".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("accepts a test environment without one", () => {
    expect(
      envValidationSchema.safeParse({ ...base, NODE_ENV: "test" }).success,
    ).toBe(true);
    expect(
      envValidationSchema.safeParse({ ...base, NODE_ENV: "development" })
        .success,
    ).toBe(true);
  });

  it("holds an existing pepper to the same floor as the auth secret", () => {
    // An eight-character pepper would be as guessable as the four-character
    // "secret" this floor exists for.
    const pepper = envValidationSchema.shape.DELETION_PEPPER;

    expect(pepper.safeParse("p").success).toBe(false);
    expect(pepper.safeParse("p".repeat(31)).success).toBe(false);
    expect(pepper.safeParse("p".repeat(32)).success).toBe(true);
    expect(pepper.safeParse(undefined).success).toBe(true);
  });
});

describe("the lifecycle knobs fail in the same boot-time document", () => {
  /**
   * Three lifecycle variables used to be validated later, in three readers with
   * three different error shapes — one of the validation fails at the schema,
   * one at the factory read, one only when the first consumer resolved it. The
   * schema now carries them, so a bad value is one named issue at boot, and the
   * pending floor lives here too rather than in a function that only ran when
   * the configuration happened to be resolved.
   */
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "s".repeat(64),
    DELETION_PEPPER: "p".repeat(64),
  };

  it("accepts every knob at its sane value", () => {
    expect(
      envValidationSchema.safeParse({
        ...base,
        DATABASE_POOL_MAX: "20",
        ACCOUNT_PURGE_GRACE_DAYS: "30",
        PENDING_DELETION_REQUEST_RETENTION_DAYS: "30",
      }).success,
    ).toBe(true);
  });

  it("refuses a pool ceiling that cannot hold a connection", () => {
    expect(
      hasNamedIssue(
        envValidationSchema.safeParse({ ...base, DATABASE_POOL_MAX: "0" }),
        "DATABASE_POOL_MAX",
      ),
    ).toBe(true);
    expect(
      hasNamedIssue(
        envValidationSchema.safeParse({ ...base, DATABASE_POOL_MAX: "abc" }),
        "DATABASE_POOL_MAX",
      ),
    ).toBe(true);
  });

  it("refuses a purge grace of less than a day", () => {
    expect(
      hasNamedIssue(
        envValidationSchema.safeParse({
          ...base,
          ACCOUNT_PURGE_GRACE_DAYS: "0",
        }),
        "ACCOUNT_PURGE_GRACE_DAYS",
      ),
    ).toBe(true);
  });

  it("refuses a pending erasure horizon that outruns its own link", () => {
    // The floor the factory applied under the same reasoning: a one-day
    // horizon sweeps the request while its confirmation link is still live.
    expect(
      hasNamedIssue(
        envValidationSchema.safeParse({
          ...base,
          PENDING_DELETION_REQUEST_RETENTION_DAYS: "1",
        }),
        "PENDING_DELETION_REQUEST_RETENTION_DAYS",
      ),
    ).toBe(true);
    expect(
      envValidationSchema.safeParse({
        ...base,
        PENDING_DELETION_REQUEST_RETENTION_DAYS: "2",
      }).success,
    ).toBe(true);
  });
});
