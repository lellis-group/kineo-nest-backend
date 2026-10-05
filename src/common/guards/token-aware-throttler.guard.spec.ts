import { describe, expect, it } from "bun:test";
import {
  clientAddress,
  TokenAwareThrottlerGuard,
} from "./token-aware-throttler.guard";

type Req = Record<string, unknown>;

/**
 * The tracker alone, with no throttler injected.
 *
 * The constructor arguments only populate the storage and the option set, and
 * the key derivation reads neither, so an empty guard is enough to pin it.
 */
function tracker(req: Req): Promise<string> {
  const guard = new TokenAwareThrottlerGuard(
    {} as never,
    {} as never,
    { getAllAndOverride: () => undefined } as never,
  );

  return (
    guard as unknown as { getTracker(request: Req): Promise<string> }
  ).getTracker(req);
}

const HASH_LENGTH = 64;

describe("clientAddress", () => {
  it("prefers the forwarded client over the proxy", () => {
    expect(clientAddress({ ip: "10.0.0.7", ips: ["203.0.113.9"] })).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to req.ip when nothing was forwarded", () => {
    expect(clientAddress({ ip: "203.0.113.9" })).toBe("203.0.113.9");
    expect(clientAddress({ ip: "203.0.113.9", ips: [] })).toBe("203.0.113.9");
  });

  it("never returns undefined, which would collapse every caller into one key", () => {
    expect(clientAddress({})).toBe("unknown");
  });
});

describe("TokenAwareThrottlerGuard", () => {
  it("keys an ordinary route on the client alone", async () => {
    await expect(
      tracker({ method: "POST", url: "/applications", ip: "203.0.113.9" }),
    ).resolves.toBe("203.0.113.9");
  });

  it("keys the erasure endpoint on the client and the token", async () => {
    const key = await tracker({
      method: "POST",
      url: "/account/confirm-deletion",
      ip: "203.0.113.9",
      body: { token: "abc" },
    });

    expect(key).toContain("203.0.113.9|");
    expect(key).not.toContain("abc");
    expect(key.slice(-HASH_LENGTH)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two holders on the same host two budgets", async () => {
    const base = {
      method: "POST",
      url: "/account/confirm-deletion",
      ip: "203.0.113.9",
    };

    const first = await tracker({ ...base, body: { token: "token-a" } });
    const second = await tracker({ ...base, body: { token: "token-b" } });

    expect(first).not.toBe(second);
  });

  it("gives the same holder the same key, so the budget accumulates", async () => {
    const base = {
      method: "POST",
      url: "/account/confirm-deletion",
      ip: "203.0.113.9",
      body: { token: "token-a" },
    };

    expect(await tracker(base)).toBe(await tracker({ ...base }));
  });

  it("reads the token from the query string too", async () => {
    const fromQuery = await tracker({
      method: "POST",
      url: "/account/confirm-deletion?token=token-a",
      ip: "203.0.113.9",
    });
    const fromBody = await tracker({
      method: "POST",
      url: "/account/confirm-deletion",
      ip: "203.0.113.9",
      body: { token: "token-a" },
    });

    expect(fromQuery).toBe(fromBody);
  });

  it("falls back to the client alone when there is no token", async () => {
    await expect(
      tracker({
        method: "POST",
        url: "/account/confirm-deletion",
        ip: "203.0.113.9",
        body: {},
      }),
    ).resolves.toBe("203.0.113.9");
  });

  it("does not read the token on a GET of the same path", async () => {
    await expect(
      tracker({
        method: "GET",
        url: "/account/confirm-deletion?token=token-a",
        ip: "203.0.113.9",
      }),
    ).resolves.toBe("203.0.113.9");
  });

  it("prefers the forwarded client on the erasure endpoint too", async () => {
    await expect(
      tracker({
        method: "POST",
        url: "/account/confirm-deletion",
        ip: "10.0.0.7",
        ips: ["203.0.113.9"],
        body: { token: "token-a" },
      }),
    ).resolves.toContain("203.0.113.9|");
  });
});
