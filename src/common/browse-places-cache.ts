/**
 * A short-lived, shared cache for the browse map's places read.
 *
 * `/replacement-listings/places` answers the same collection to every member:
 * the feed shows OPEN and IN_DISCUSSION listings under public practices, with
 * nothing scoped to the caller. That is what makes one Redis entry per filter
 * safe — the session is still resolved by the global guard before this runs,
 * only the three SQL reads behind the response are spared.
 *
 * It is deliberately fail-open, like the throttler and better-auth's rate limit
 * storage beside it: a Redis outage must cost a cache hit, not the endpoint.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { type Observable, of, tap } from "rxjs";
import { logError } from "../lib/log";

/** Bounded staleness, the same window the browse responses already advertise. */
export const BROWSE_PLACES_CACHE_TTL = 15;

const KEY_PREFIX = "kineo:browse:places:";

/** The small surface the interceptor needs, so a test can pass a fake. */
export interface PlacesResponseCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

@Injectable()
export class PlacesResponseCacheService
  implements PlacesResponseCache, OnModuleDestroy
{
  private readonly redis: Redis | null;

  constructor(config: ConfigService) {
    const url = config.get<string>("redisUrl");
    if (!url) {
      // Development and CI run without Redis; caching is simply off there.
      this.redis = null;
      return;
    }

    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // ioredis emits 'error' on a failed connection; with no listener that
    // becomes an unhandled error instead of a miss.
    this.redis.on("error", (error: unknown) => {
      logError("http.browse_cache.redis_error", error);
    });
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(key);
    } catch (error) {
      logError("http.browse_cache.redis_get_failed", error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (error) {
      logError("http.browse_cache.redis_set_failed", error);
    }
  }

  async close(): Promise<void> {
    await this.redis?.quit();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

@Injectable()
export class BrowsePlacesCacheInterceptor implements NestInterceptor {
  // The interface is erased at runtime, so the injectable class is the token.
  constructor(
    @Inject(PlacesResponseCacheService)
    private readonly cache: PlacesResponseCache,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context
      .switchToHttp()
      .getRequest<{ originalUrl?: string }>();
    const url = request.originalUrl;

    // Defence in depth: this cache is shared across members, so even a
    // misplaced decorator must never put an owner-scoped answer in it.
    if (!url?.includes("/replacement-listings/places")) {
      return next.handle();
    }

    const key = `${KEY_PREFIX}${url}`;
    let hit: string | null = null;
    try {
      hit = await this.cache.get(key);
    } catch (error) {
      // The service fails open itself; this also covers a cache replaced by
      // another implementation that does not.
      logError("http.browse_cache.lookup_failed", error);
    }
    if (hit !== null) {
      try {
        return of(JSON.parse(hit) as unknown);
      } catch {
        // A corrupt entry is a miss, not a failed request.
      }
    }

    return next.handle().pipe(
      tap((value) => {
        void this.cache.set(
          key,
          JSON.stringify(value),
          BROWSE_PLACES_CACHE_TTL,
        );
      }),
    );
  }
}
