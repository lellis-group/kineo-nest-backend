import { describe, expect, it } from "bun:test";
import type { Redis } from "ioredis";
import { createRedisRateLimitStorage } from "./rate-limit-redis";

/**
 * A two-client Redis server small enough to read in one screen.
 *
 * `expiresAt: null` is Redis's "key with no TTL", `0` the status of an expiry
 * that was not applied, and `-2` the TTL of a missing key — the three states the
 * real commands can leave behind and the ones a fake worth running has to
 * reproduce. The clock moves with `advance()`, so window expiry is asserted,
 * never slept.
 */
type Row = { count: number; expiresAt: number | null };

function fakeRedisServer() {
  let now = 1_000; // a fake epoch, in seconds
  const rows = new Map<string, Row>();

  function row(key: string): Row | undefined {
    const row = rows.get(key);
    if (row && row.expiresAt !== null && row.expiresAt <= now) {
      rows.delete(key);
      return undefined;
    }
    return row;
  }

  function client(): Redis {
    let commands: Array<
      | { op: "incr"; key: string }
      | { op: "expire"; key: string; ttl: number }
      | { op: "ttl"; key: string }
    > = [];

    const pipeline = {
      incr(key: string) {
        commands.push({ op: "incr", key });
        return pipeline;
      },
      expire(key: string, ttl: number) {
        commands.push({ op: "expire", key, ttl });
        return pipeline;
      },
      ttl(key: string) {
        commands.push({ op: "ttl", key });
        return pipeline;
      },
      exec() {
        // One batch per exec: a real pipeline carries exactly the commands it
        // was given, so the queue cannot leak into the next one.
        const batch = commands;
        commands = [];
        return Promise.resolve(
          batch.map((command) => {
            const existing = row(command.key);
            switch (command.op) {
              case "incr": {
                const fresh = existing ?? { count: 0, expiresAt: null };
                fresh.count += 1;
                rows.set(command.key, fresh);
                return [null, fresh.count] as const;
              }
              case "expire": {
                const applied = existing && existing.expiresAt === null;
                if (applied) {
                  existing.expiresAt = now + command.ttl;
                  rows.set(command.key, existing);
                }
                return [null, applied ? 1 : 0] as const;
              }
              case "ttl": {
                const remaining =
                  existing === undefined
                    ? -2
                    : existing.expiresAt === null
                      ? -1
                      : Math.max(Math.ceil(existing.expiresAt - now), 0);
                return [null, remaining] as const;
              }
            }
          }),
        );
      },
    };

    return {
      pipeline: () => pipeline,
      quit: async () => undefined,
    } as unknown as Redis;
  }

  function brokenClient(): Redis {
    return {
      pipeline: () => {
        throw new Error("ECONNREFUSED");
      },
      quit: async () => undefined,
    } as unknown as Redis;
  }

  function erroringClient(): Redis {
    // The way ioredis reports a failed command: not a throw, but an [error,
    // result] tuple the caller has to notice.
    const fail: [Error, null] = [new Error("READONLY"), null];
    const chain = {
      incr: () => chain,
      expire: () => chain,
      ttl: () => chain,
      exec: () => Promise.resolve([fail, fail, fail]),
    };
    return {
      pipeline: () => chain,
      quit: async () => undefined,
    } as unknown as Redis;
  }

  return {
    advance: (seconds: number) => void (now += seconds),
    client,
    brokenClient,
    erroringClient,
    rows,
  };
}

const RULE = { window: 10, max: 2 };
const KEY = "203.0.113.9|/sign-in/email";

describe("createRedisRateLimitStorage", () => {
  it("counts the first hit into a key that expires with the window", async () => {
    const server = fakeRedisServer();
    const storage = createRedisRateLimitStorage(server.client());

    await expect(storage.consume(KEY, RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(server.rows.get(`kineo:auth:rate-limit:${KEY}`)?.count).toBe(1);
  });

  it("stops at the limit, and says when the window frees up", async () => {
    const server = fakeRedisServer();
    const storage = createRedisRateLimitStorage(server.client());

    await storage.consume(KEY, RULE);
    await expect(storage.consume(KEY, RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });

    const refused = await storage.consume(KEY, RULE);
    expect(refused.allowed).toBe(false);
    // A few ms of pipeline latency after the expire means the TTL reads a tick
    // under the window, never above it.
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(RULE.window);
  });

  it("resets on a fixed window, the shape better-auth's own Redis backends use", async () => {
    const server = fakeRedisServer();
    const storage = createRedisRateLimitStorage(server.client());

    await storage.consume(KEY, RULE);
    await storage.consume(KEY, RULE);
    server.advance(RULE.window);

    await expect(storage.consume(KEY, RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(server.rows.get(`kineo:auth:rate-limit:${KEY}`)?.count).toBe(1);
  });

  it("shares one budget when two clients hold the same server", async () => {
    // The reason this storage exists: storage inside each process lets N replicas
    // allow N times the configured budget. Two clients over one server are those
    // replicas.
    const server = fakeRedisServer();
    const first = createRedisRateLimitStorage(server.client());
    const second = createRedisRateLimitStorage(server.client());

    await first.consume(KEY, { ...RULE, max: 1 });
    await expect(
      second.consume(KEY, { ...RULE, max: 1 }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("does not let a concurrent hit reset a window already under way", async () => {
    // EXPIRE NX is the point of the pipeline: every non-creating hit leaves the
    // TTL of the first one alone, so mixing two clients never extends a window.
    const server = fakeRedisServer();
    const first = createRedisRateLimitStorage(server.client());
    const second = createRedisRateLimitStorage(server.client());

    await first.consume(KEY, RULE);
    server.advance(4);
    await second.consume(KEY, RULE);

    // The second hit went into the first hit's window: five seconds in, the TTL
    // has five seconds left, not ten.
    const ttl = server.rows.get(`kineo:auth:rate-limit:${KEY}`)?.expiresAt;
    expect(ttl).not.toBeNull();
    expect((ttl as number) - (1_000 + 4)).toBeLessThanOrEqual(RULE.window);
  });

  it("opens the gate when Redis is unreachable, rather than failing sign-in", async () => {
    const storage = createRedisRateLimitStorage(
      fakeRedisServer().brokenClient(),
    );

    await expect(storage.consume(KEY, RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
  });

  it("reads a failed command the way ioredis reports it, and opens the gate too", async () => {
    // A command failure arrives as an [error, result] tuple, not as a throw on
    // the pipeline — the fail-open has to catch both shapes.
    const storage = createRedisRateLimitStorage(
      fakeRedisServer().erroringClient(),
    );

    await expect(storage.consume(KEY, RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
  });

  it("hangs up the connection it was given", async () => {
    // it lives for the process, but the handle it owns is this one's to close.
    let quit = 0;
    const handle = fakeRedisServer().client() as unknown as {
      quit: () => Promise<unknown>;
    };
    const plainQuit = handle.quit.bind(handle);
    handle.quit = async () => {
      quit += 1;
      await plainQuit();
    };

    await createRedisRateLimitStorage(handle as unknown as Redis).close();

    expect(quit).toBe(1);
  });
});
