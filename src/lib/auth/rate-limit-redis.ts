import type { Redis } from "ioredis";
import { logError } from "../log";

/**
 * The better-auth buckets, counted in Redis.
 *
 * better-auth's own storage is a Map inside the process, so with N replicas
 * every credential budget (`CREDENTIAL_RATE_LIMIT_*`, `CHANGE_EMAIL_RATE_LIMIT_*`)
 * is N times larger than it reads. The NestJS throttler solved that exact problem
 * with `ThrottlerStorageRedisService`; this is the same move for better-auth,
 * which 1.7 does not answer with a Redis backend of its own — its contract is
 * `rateLimit.customStorage`, and this implements it.
 *
 * The contract (`BetterAuthRateLimitStorage.consume`) demands that the check and
 * the increment happen in a single step: a separate `get`/`set` lets N
 * simultaneous requests all pass a stale read before any increment lands, which
 * is a distributed limit that does not limit. The pipeline below is one ordered
 * round trip per `consume`, and every command in it is atomic on its own —
 * `INCR` decides the count, `EXPIRE` with `NX` timestamps only the hit that
 * created the key, so a concurrent hit cannot reset a window already under way.
 */

/** Prefix so one Redis can carry the throttler's keys as well as these. */
const KEY_PREFIX = "kineo:auth:rate-limit:";

export interface RedisRateLimitStorage {
  /** Better Auth's `rateLimit.customStorage` contract. */
  consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
  /** Hangs up the connection it was given. */
  close(): Promise<void>;
}

export function createRedisRateLimitStorage(
  redis: Redis,
): RedisRateLimitStorage {
  return {
    async consume(key, rule) {
      const namespaced = `${KEY_PREFIX}${key}`;

      try {
        const results = await redis
          .pipeline()
          .incr(namespaced)
          .expire(namespaced, rule.window, "NX")
          .ttl(namespaced)
          .exec();
        if (!results) {
          throw new Error(`pipeline returned nothing for ${namespaced}`);
        }

        const [incrResult, , ttlResult] = results;
        if (!incrResult || incrResult[0]) {
          throw new Error(`INCR failed on ${namespaced}`);
        }
        const count = Number(incrResult[1]);

        // The window counts from the first hit of its span (a fixed window, the
        // same shape better-auth's own secondary-storage backend has), so the
        // time that remains is the key's TTL. A key with no TTL yet has
        // EXPIRE NX waiting to land on the moment it was created; if it somehow
        // has none, the honest fallback is the configured window.
        const ttlSeconds = Number(ttlResult?.[1] ?? -1);
        if (count > rule.max) {
          return {
            allowed: false,
            retryAfter: ttlSeconds > 0 ? ttlSeconds : rule.window,
          };
        }
        return { allowed: true, retryAfter: null };
      } catch (error) {
        // Fail open. A rate limiter that answers on nothing should not take
        // authentication down with it; the NestJS throttler counting the same
        // Redis fails open the same way (`common/throttle.ts`), and with both
        // doing so, an outage costs neither piece of the stack its honest
        // failure — its limit, which is what it may not protect anyway.
        logError("auth.rate_limit.redis_consume_failed", error);
        return { allowed: true, retryAfter: null };
      }
    },

    async close() {
      await redis.quit();
    },
  };
}
