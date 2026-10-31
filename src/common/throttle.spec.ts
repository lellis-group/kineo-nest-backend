import { describe, expect, it } from "bun:test";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  THROTTLER_LIMIT,
  THROTTLER_SKIP,
  THROTTLER_TTL,
} from "@nestjs/throttler/dist/throttler.constants";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import {
  DELETION_THROTTLE_KEY,
  FailOpenThrottlerStorage,
  THROTTLE_NAMES,
  ThrottleDeletion,
  ThrottleWithConfig,
  throttlerModuleOptions,
} from "./throttle";

/**
 * A read of what the decorators actually put in the metadata, not of what they
 * were meant to.
 *
 * `@nestjs/throttler` prefixes every key with the tier's name and prefers a
 * route's own `THROTTLER_LIMIT + name` over the tier the module registered
 * (`throttler.guard.js:83-84`), so a decorator that sets a limit silently
 * replaces the validated configuration with whatever it read. Both decorators
 * used to do exactly that, with values read from `process.env` at import time.
 *
 * The decorators are applied to a method, because that is how the controllers use
 * them and because `SkipThrottle` writes to the descriptor's function.
 */
function metadataOn(
  decorator: ReturnType<typeof ThrottleWithConfig>,
): Record<string, unknown> {
  class Target {
    handler(): void {}
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    Target.prototype,
    "handler",
  );
  decorator(Target.prototype, "handler", descriptor as PropertyDescriptor);

  const reflector = new Reflector();
  const target = descriptor?.value as () => void;
  const read = (base: string, name: string) =>
    reflector.get(base + name, target);

  return {
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [
        `limit:${name}`,
        read(THROTTLER_LIMIT, name),
      ]),
    ),
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [`ttl:${name}`, read(THROTTLER_TTL, name)]),
    ),
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [
        `skip:${name}`,
        read(THROTTLER_SKIP, name),
      ]),
    ),
    erasure: reflector.get(DELETION_THROTTLE_KEY, target),
  };
}

describe("throttle decorators", () => {
  it("set no limit and no TTL, so the validated configuration decides", () => {
    for (const metadata of [
      metadataOn(ThrottleWithConfig("medium")),
      metadataOn(ThrottleDeletion()),
    ]) {
      for (const name of THROTTLE_NAMES) {
        expect(metadata[`limit:${name}`]).toBeUndefined();
        expect(metadata[`ttl:${name}`]).toBeUndefined();
      }
    }
  });

  it("skips the other global tiers and leaves the one it names alone", () => {
    const metadata = metadataOn(ThrottleWithConfig("medium"));

    expect(metadata["skip:short"]).toBe(true);
    expect(metadata["skip:long"]).toBe(true);
    expect(metadata["skip:medium"]).toBeUndefined();
  });

  it("opts the erasure route into its tier, and that tier only", () => {
    const metadata = metadataOn(ThrottleDeletion());

    expect(metadata.erasure).toBe(true);
    // The erasure tier is registered but skipped everywhere else, so opting a
    // single route in is the whole mechanism.
    for (const name of THROTTLE_NAMES) {
      expect(metadata[`skip:${name}`]).toBe(true);
    }
  });
});

describe("throttlerModuleOptions", () => {
  /**
   * A ConfigService over the keys `configuration()` publishes, which is what the
   * module factory reads: `throttle.short.ttl`, not `THROTTLE_SHORT_TTL`.
   */
  function configWith(values: Record<string, unknown> = {}): ConfigService {
    return {
      get: <T>(key: string, fallback?: T) =>
        (key in values ? values[key] : fallback) as T,
      getOrThrow: <T>(key: string) => {
        if (!(key in values)) {
          throw new Error(`${key} is not configured`);
        }
        return values[key] as T;
      },
    } as unknown as ConfigService;
  }

  const LIMITS = {
    "throttle.short.ttl": 1000,
    "throttle.short.limit": 5,
    "throttle.medium.ttl": 10_000,
    "throttle.medium.limit": 30,
    "throttle.long.ttl": 60_000,
    "throttle.long.limit": 150,
    "throttle.deletion.ttl": 900_000,
    "throttle.deletion.limit": 5,
  };

  it("counts in memory when no Redis is configured", () => {
    // Development and CI have no Redis, and the built-in storage is the fallback.
    const options = throttlerModuleOptions(
      configWith({ ...LIMITS, redisUrl: undefined }),
      new Reflector(),
    );

    expect(options.storage).toBeUndefined();
  });

  it("shares the buckets once a Redis URL is configured", () => {
    // In memory the buckets are per process: N replicas allow N times the
    // configured budget, which is the whole of what those numbers mean.
    const options = throttlerModuleOptions(
      configWith({ ...LIMITS, redisUrl: "redis://localhost:6379" }),
      new Reflector(),
    );

    // The storage is wrapped: what the guard reads through is the fail-open
    // surrogate, whose own suite pins what it answers when Redis is gone.
    expect(options.storage).toBeInstanceOf(FailOpenThrottlerStorage);
  });
});

describe("FailOpenThrottlerStorage", () => {
  /** An inner storage the tests codify a verdict for, without any Redis. */
  function innerThat(
    behavior: { throws?: Error; record?: ThrottlerStorageRecord } = {},
  ): ThrottlerStorageRedisService {
    return {
      redis: {},
      increment: async () => {
        if (behavior.throws) {
          throw behavior.throws;
        }
        return (
          behavior.record ?? {
            totalHits: 1,
            timeToExpire: 999,
            isBlocked: false,
            timeToBlockExpire: 0,
          }
        );
      },
      onModuleDestroy: async () => undefined,
    } as unknown as ThrottlerStorageRedisService;
  }

  const CALL = ["key", 60_000, 5, 30_000, "short"] as const;

  it("counts what Redis counted while it answers", async () => {
    // The wrapper is transparent on the path requests take on an ordinary
    // day: the block decision and the hit count must be exactly Redis's.
    const storage = new FailOpenThrottlerStorage(
      innerThat({
        record: {
          totalHits: 4,
          timeToExpire: 55_000,
          isBlocked: true,
          timeToBlockExpire: 3_000,
        },
      }),
    );

    expect(await storage.increment(...CALL)).toEqual({
      totalHits: 4,
      timeToExpire: 55_000,
      isBlocked: true,
      timeToBlockExpire: 3_000,
    });
  });

  it("lets the request through when Redis refuses, and keeps its own answer out of the process", async () => {
    // `ThrottlerStorageRedisService` raises whatever Redis raised, and the
    // guard calls `increment` on every request — a global guard means a dead
    // Redis answers the whole API with 500, `/health` included. The answer
    // below cannot throttle anyone: no hit is counted and nobody is blocked,
    // which is the load an outage may not protect anyway.
    const outage = new Error("Connection is closed.");
    const storage = new FailOpenThrottlerStorage(innerThat({ throws: outage }));

    expect(await storage.increment(...CALL)).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it("exposes the connection the inner service holds", () => {
    // The guard never touches `redis` itself today, but the `ThrottlerStorage`
    // contract carries it — and whatever speaks to this storage next should
    // see the same Redis, not a proxy that owns a second connection.
    const fake = innerThat();
    const storage = new FailOpenThrottlerStorage(fake);

    expect(storage.redis).toBe(fake.redis);
  });

  it("alive until the module's shutdown hook lets the inner service quit", async () => {
    const calls: string[] = [];
    const exited = {
      redis: {},
      onModuleDestroy: async () => {
        calls.push("inner quit");
      },
    };
    const storage = new FailOpenThrottlerStorage(
      exited as unknown as ThrottlerStorageRedisService,
    );

    await storage.onModuleDestroy();

    // The wrapper does not answer before the inner disconnect has: a teardown
    // that returns early leaves the socket half-open.
    expect(calls).toEqual(["inner quit"]);
  });
});
