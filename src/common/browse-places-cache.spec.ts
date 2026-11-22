import { describe, expect, it } from "bun:test";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { firstValueFrom, of } from "rxjs";
import {
  BROWSE_PLACES_CACHE_TTL,
  BrowsePlacesCacheInterceptor,
  PlacesResponseCacheService,
} from "./browse-places-cache";

function fakeCache(stored: string | null = null) {
  const gets: string[] = [];
  const sets: Array<{ key: string; value: string; ttl: number }> = [];
  let value = stored;

  return {
    gets,
    sets,
    get: async (key: string) => {
      gets.push(key);
      return value;
    },
    set: async (key: string, next: string, ttl: number) => {
      sets.push({ key, value: next, ttl });
      value = next;
    },
    close: async () => {},
  };
}

function context(url: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ originalUrl: url }) }),
  } as unknown as ExecutionContext;
}

function handler(value: unknown) {
  let calls = 0;
  const handle: CallHandler["handle"] = () => {
    calls += 1;
    return of(value);
  };
  return {
    calls: () => calls,
    handle: () => handle(),
  };
}

const PLACES_URL = "/replacement-listings/places?city=Lyon";
const PAYLOAD = { places: [], unlocated: 0, totalPlaces: 0, truncated: false };

describe("BrowsePlacesCacheInterceptor", () => {
  it("reuses a stored answer without reaching the service", async () => {
    const cache = fakeCache(JSON.stringify(PAYLOAD));
    const next = handler({ places: [] });
    const interceptor = new BrowsePlacesCacheInterceptor(cache);

    const result = await firstValueFrom(
      await interceptor.intercept(context(PLACES_URL), next),
    );

    expect(result).toEqual(PAYLOAD);
    expect(next.calls()).toBe(0);
    expect(cache.gets).toEqual([`kineo:browse:places:${PLACES_URL}`]);
  });

  it("stores a fresh answer for fifteen seconds", async () => {
    const cache = fakeCache();
    const next = handler(PAYLOAD);
    const interceptor = new BrowsePlacesCacheInterceptor(cache);

    const result = await firstValueFrom(
      await interceptor.intercept(context(PLACES_URL), next),
    );

    expect(result).toEqual(PAYLOAD);
    expect(next.calls()).toBe(1);
    expect(cache.sets).toEqual([
      {
        key: `kineo:browse:places:${PLACES_URL}`,
        value: JSON.stringify(PAYLOAD),
        ttl: BROWSE_PLACES_CACHE_TTL,
      },
    ]);
  });

  it("treats a corrupt entry as a miss", async () => {
    const cache = fakeCache("{not json");
    const next = handler(PAYLOAD);
    const interceptor = new BrowsePlacesCacheInterceptor(cache);

    const result = await firstValueFrom(
      await interceptor.intercept(context(PLACES_URL), next),
    );

    expect(result).toEqual(PAYLOAD);
    expect(next.calls()).toBe(1);
  });

  it("fails open when Redis cannot be read", async () => {
    const cache = {
      ...fakeCache(),
      get: async () => {
        throw new Error("redis down");
      },
    };
    const next = handler(PAYLOAD);
    const interceptor = new BrowsePlacesCacheInterceptor(cache);

    const result = await firstValueFrom(
      await interceptor.intercept(context(PLACES_URL), next),
    );

    expect(result).toEqual(PAYLOAD);
    expect(next.calls()).toBe(1);
  });

  it("never caches another route, even if it is decorated by mistake", async () => {
    const cache = fakeCache();
    const next = handler(PAYLOAD);
    const interceptor = new BrowsePlacesCacheInterceptor(cache);

    await firstValueFrom(
      await interceptor.intercept(context("/replacement-listings/mine"), next),
    );

    expect(cache.gets).toEqual([]);
    expect(cache.sets).toEqual([]);
    expect(next.calls()).toBe(1);
  });
});

describe("PlacesResponseCacheService", () => {
  it("is inert without a Redis URL", async () => {
    const service = new PlacesResponseCacheService({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(await service.get("key")).toBeNull();
    await service.set("key", "value", 15);
    await service.close();
  });
});
