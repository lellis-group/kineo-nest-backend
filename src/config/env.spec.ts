import { describe, expect, it } from "bun:test";
import configuration, { envValidationSchema } from "./configuration";
import { isHardenedEnv } from "./env";

function applyEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  applyEnv(saved);
}

/** Runs `configuration()` under `vars`, then puts the environment back. */
function buildWith(vars: Record<string, string | undefined>) {
  const previous = { ...process.env };
  applyEnv(vars);
  try {
    return configuration();
  } finally {
    process.env = previous;
  }
}

describe("isHardenedEnv", () => {
  it("treats development and test as non-hardened", () => {
    expect(isHardenedEnv("development")).toBe(false);
    expect(isHardenedEnv("test")).toBe(false);
  });

  it("treats production and provision as hardened", () => {
    expect(isHardenedEnv("production")).toBe(true);
    expect(isHardenedEnv("provision")).toBe(true);
  });

  it("defaults to hardened for missing or unknown values", () => {
    expect(isHardenedEnv(undefined)).toBe(true);
    expect(isHardenedEnv(null)).toBe(true);
    expect(isHardenedEnv("")).toBe(true);
    expect(isHardenedEnv("staging")).toBe(true);
    expect(isHardenedEnv("Production")).toBe(true);
    expect(isHardenedEnv("DEVELOPMENT")).toBe(false);
  });

  // The branch above is only reachable if nothing substitutes a value first.
  // `configuration()` used to default `nodeEnv` to `development`, so every gate
  // reading it took the non-hardened path on a deployment that never set
  // NODE_ENV — which is what the Dockerfile does.
  it("stays hardened when configuration() is given no NODE_ENV", () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      trustProxy: process.env.TRUST_PROXY,
    };
    delete process.env.NODE_ENV;
    delete process.env.TRUST_PROXY;

    try {
      const config = configuration();

      expect(config.nodeEnv).toBe("production");
      expect(isHardenedEnv(config.nodeEnv)).toBe(true);
      expect(config.trustProxy).toBe(true);
    } finally {
      restoreEnv(previous);
    }
  });

  it("keeps trust proxy opt-out where every caller shares an IP", () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      trustProxy: process.env.TRUST_PROXY,
    };
    process.env.NODE_ENV = "test";

    try {
      delete process.env.TRUST_PROXY;
      expect(configuration().trustProxy).toBe(false);

      process.env.TRUST_PROXY = "false";
      expect(configuration().trustProxy).toBe(false);

      process.env.TRUST_PROXY = "true";
      expect(configuration().trustProxy).toBe(true);
    } finally {
      restoreEnv(previous);
    }
  });
});

describe("configuration bounds", () => {
  it("rejects a throttle window Node's setTimeout would clamp", () => {
    // 30 days passes every other check. `@nestjs/throttler` arms a setTimeout
    // with it and Node clamps anything past 2^31-1 ms to 1 ms, so the tier would
    // stop limiting anything while still reporting as configured.
    expect(() => buildWith({ THROTTLE_LONG_TTL: "2592000000" })).toThrow(
      /THROTTLE_LONG_TTL/,
    );
    expect(() => buildWith({ THROTTLE_DELETION_TTL: "2592000000" })).toThrow(
      /THROTTLE_DELETION_TTL/,
    );
  });

  it("rejects a pending-request horizon shorter than the token", () => {
    // The token lives 24h; a one-day horizon sweeps the PENDING trail row
    // before the emailed link expires, and every confirmation then fails.
    expect(() =>
      buildWith({ PENDING_DELETION_REQUEST_RETENTION_DAYS: "1" }),
    ).toThrow(/at least 2 days/);
  });

  it("accepts the smallest workable pending-request horizon", () => {
    expect(
      buildWith({ PENDING_DELETION_REQUEST_RETENTION_DAYS: "2" })
        .pendingDeletionRequestRetentionDays,
    ).toBe(2);
  });

  it("still refuses a non-positive throttle value", () => {
    expect(() => buildWith({ THROTTLE_SHORT_TTL: "0" })).toThrow(
      /THROTTLE_SHORT_TTL/,
    );
  });

  it("requires an auth secret long enough to key sessions with", () => {
    // better-auth derives its session cookies and its request-signing HMAC from
    // this value, so `min(1)` let a four-character secret boot successfully.
    const base = { NODE_ENV: "development", DATABASE_URL: "postgresql://x/y" };

    expect(
      envValidationSchema.safeParse({ ...base, BETTER_AUTH_SECRET: "short" })
        .success,
    ).toBe(false);

    expect(
      envValidationSchema.safeParse({
        ...base,
        BETTER_AUTH_SECRET: "s".repeat(32),
      }).success,
    ).toBe(true);
  });
});
