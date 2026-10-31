import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import {
  applyDecorators,
  type ExecutionContext,
  SetMetadata,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Reflector } from "@nestjs/core";
import {
  SkipThrottle,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import { logError } from "../lib/log";

/**
 * The throttle tiers the global guard applies to every route.
 *
 * The names live here because both the module that registers them and the
 * decorator that narrows a route to one of them have to agree, and a tier
 * declared in only one of the two is applied to the whole API.
 */
export const THROTTLE_NAMES = ["short", "medium", "long"] as const;

export type ThrottleName = (typeof THROTTLE_NAMES)[number];

/**
 * The erasure tier, and the metadata that opts a route into it.
 *
 * The tier is registered so the guard can apply it, but it carries a `skipIf`
 * that refuses it everywhere except a route decorated with ThrottleDeletion.
 * Without that, registering it would extend its limit to every endpoint in the
 * API — and on the routes that legitimately opt out, the guard's error path
 * would still count them.
 */
export const DELETION_THROTTLE_KEY = "kineo:throttle:deletion";

/**
 * Applies one configured tier to a route and skips the other global ones.
 *
 * The decorator narrows *which* tiers apply; it deliberately does not say how big
 * they are. `@nestjs/throttler` resolves the numbers in this order
 * (`throttler.guard.js:83-84`):
 *
 * ```js
 * const limit = await this.resolveValue(context, routeOrClassLimit || namedThrottler.limit);
 * const ttl   = await this.resolveValue(context, routeOrClassTtl  || namedThrottler.ttl);
 * ```
 *
 * So a `Throttle()` here wins over the tier registered by
 * `ThrottlerModule.forRootAsync`. This decorator used to carry one, with values
 * read by calling `configuration()` — which reads `process.env` and bypasses the
 * validated `ConfigService` — at the moment the controller module was imported.
 * The result was a second, frozen copy of every limit, on every route wearing
 * the decorator: changing `THROTTLE_LONG_TTL` in the environment had no effect on
 * them.
 *
 * The numbers now come from `forRootAsync` and its `ConfigService`, which is the
 * single validated source. `throttle.spec.ts` pins that the decorators set no
 * limit or TTL at all, so this cannot come back unnoticed.
 */
export function ThrottleWithConfig(throttleName: ThrottleName) {
  return applyDecorators(
    SkipThrottle(
      Object.fromEntries(
        THROTTLE_NAMES.filter((name) => name !== throttleName).map((name) => [
          name,
          true,
        ]),
      ),
    ),
  );
}

/**
 * The erasure tier on one route, and the erasure tier off everywhere else.
 *
 * Same reasoning as `ThrottleWithConfig`: this only opts in. The endpoint is
 * anonymous and its token is the only proof of identity, so it gets the erasure
 * budget — a long window with a small allowance — rather than the global
 * one-second tier. The budget itself is the one `forRootAsync` registered.
 */
export function ThrottleDeletion() {
  return applyDecorators(
    SetMetadata(DELETION_THROTTLE_KEY, true),
    SkipThrottle(
      Object.fromEntries(THROTTLE_NAMES.map((name) => [name, true])),
    ),
  );
}

/**
 * How the throttler's own Redis client survives an outage it is *connecting* to.
 *
 * `maxRetriesPerRequest: 1` keeps a dead Redis from farming the inbox: without it
 * ioredis queues a retry for every command until its own default is exhausted,
 * which is sixty attempts per request and a queue that only watches requests
 * time out. `enableOfflineQueue: false` makes those commands fail at once
 * instead of piling up while the client waits for a Redis that may not come
 * back — the queue exists to ride over a restart, but a window of seconds is
 * all a window counter can afford.
 */
const REDIS_INCREMENT_OPTIONS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
} as const;

/**
 * The throttler's counters, with an outage in front of them.
 *
 * The guard is global (`app.module.ts`), so the storage's `increment` runs on
 * every request — including `/health` — and `ThrottlerStorageRedisService`
 * raises whatever Redis raised, with nothing between it and the caller. The
 * moment Redis went down, every request answered 500 while its own data was
 * fine; this wraps the storage so the answer is "let it through" instead.
 *
 * Fail-open is the deliberate trade, and it is one-sided: what is lost is a
 * rate limit during an outage, on a day when a deployment is fighting
 * something bigger. What is kept is the rest of the API. The better-auth
 * storage beside it fails open the same way (`rate-limit-redis.ts`), and with
 * the guard now doing so too, an outage costs neither piece of the stack its
 * honest failure.
 *
 * The counters fail locked rather than open when Redis *answers* but denies —
 * that is a throttle speaking, not an outage.
 */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly inner: ThrottlerStorageRedisService) {}

  /** The connection the inner service holds, exposed the contract expects. */
  get redis() {
    return this.inner.redis;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    } catch (error) {
      // The log is rate-limited against itself: once redis is down, the same
      // failure line would arrive once per request, and a burst of traffic
      // turns one outage into a log flood.
      logError("http.throttle.redis_increment_failed", error);
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  async onModuleDestroy() {
    await this.inner.onModuleDestroy();
  }
}

/**
 * The tiers the module registers, and the storage they are counted in.
 *
 * The built-in storage is a Map inside the process, so with N replicas every
 * limit is N times larger than it reads — which is the whole of what those
 * numbers mean. `REDIS_URL` is what makes the buckets shared; without it the
 * module falls back to the in-memory one, so development and CI need no Redis.
 */
export function throttlerModuleOptions(
  config: ConfigService,
  reflector: Reflector,
): Extract<ThrottlerModuleOptions, { throttlers: ThrottlerOptions[] }> {
  const redisUrl = config.get<string>("redisUrl");

  return {
    throttlers: [
      ...THROTTLE_NAMES.map((name) => ({
        name,
        ttl: config.getOrThrow<number>(`throttle.${name}.ttl`),
        limit: config.getOrThrow<number>(`throttle.${name}.limit`),
      })),
      {
        name: "deletion" as ThrottleName,
        ttl: config.getOrThrow<number>("throttle.deletion.ttl"),
        limit: config.getOrThrow<number>("throttle.deletion.limit"),
        // Applied only where a route opted in with ThrottleDeletion:
        // registering it unconditionally would extend its budget to every
        // endpoint in the API.
        skipIf: (context: ExecutionContext) =>
          reflector.getAllAndOverride(DELETION_THROTTLE_KEY, [
            context.getHandler(),
            context.getClass(),
          ]) !== true,
      },
    ],
    storage: redisUrl
      ? new FailOpenThrottlerStorage(
          new ThrottlerStorageRedisService(redisUrl, REDIS_INCREMENT_OPTIONS),
        )
      : undefined,
  };
}
