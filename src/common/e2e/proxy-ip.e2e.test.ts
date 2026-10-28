/**
 * The client IP, as better-auth resolves it from the forwarded chain.
 *
 * Express never sees the auth routes — they are mounted as middleware — so the
 * IP the NestJS throttler keys on and the IP better-auth keys on come from two
 * different walkers. This suite pins the second one where it matters: the
 * `Session.ipAddress` column is the only durable record of where a sign-in came
 * from, and the rate-limit buckets are as wide as the address better-auth
 * managed to resolve.
 *
 * `TRUST_PROXY_IPS` is the trusted hop (10.0.0.0/8, the address your proxy
 * would come from) and the chains are set directly on the request, which is the
 * same thing a real proxy does to the header. This process talks to the
 * application directly, not through a proxy — the network path that makes
 * trusting these entries safe exists only in deployment, and that part is the
 * deployment's assertion to hold, not a test's.
 */

// The app boots once per process and reads its environment on boot, so the
// trusted list is set here rather than left to the runner: `bun run test:e2e`
// discovers suites and would not know to pass it. Loopback is on the list
// because this process talks to the application directly — the socket hop is
// the first one the walk checks, and a list that does not trust it stops there.
// The throttler tier keeps its production shape (the harness opt-in below)
// because the Nest-layer case has to exhaust a small budget.
process.env.TRUST_PROXY_IPS = "127.0.0.1/32, 10.0.0.0/8";
process.env.TRUST_PROXY = "true";
process.env.KINEO_E2E_REAL_SHORT_BUDGET = "1";
process.env.THROTTLE_SHORT_TTL = "60000";
process.env.THROTTLE_SHORT_LIMIT = "5";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootApp,
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

interface SignInResult {
  status: number;
  cookie: string;
}

async function signIn(
  email: string,
  password: string,
  forwardedFor?: string,
): Promise<SignInResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (forwardedFor !== undefined) {
    headers["x-forwarded-for"] = forwardedFor;
  }

  const response = await fetch(`${fx.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });

  return {
    status: response.status,
    cookie: response.headers.get("set-cookie") ?? "",
  };
}

/** Signs in behind the named chain and reads back the session it recorded. */
async function signInAndReadSession(
  userId: string,
  forwardedFor?: string,
): Promise<string | null> {
  await resetData(fx.prisma);
  await createVerifiedUser(
    fx.prisma,
    userId,
    `${userId}@test.invalid`,
    PASSWORD,
  );

  const result = await signIn(`${userId}@test.invalid`, PASSWORD, forwardedFor);
  if (result.status !== 200) {
    throw new Error(`sign-in failed with ${result.status}: ${result.cookie}`);
  }

  const session = await fx.prisma.session.findFirst();
  return session?.ipAddress ?? null;
}

describe("the session ipAddress behind a trusted proxy", () => {
  it("takes the first untrusted address of a forwarded chain, walking right to left", async () => {
    // The classic two-hop shape: caller-supplied value, then the proxy. The
    // proxy is on the trusted list, so the address that survives is the one in
    // front of it.
    expect(
      await signInAndReadSession("user-behind-proxy", "203.0.113.7, 10.0.0.1"),
    ).toBe("203.0.113.7");
  });

  it("stops the walk at an untrusted hop rather than skipping past it", async () => {
    // Elsewhere: a chain the proxies did not append to. The rightmost value is
    // not on the trusted list, so it is where the walk ends — spoofing is
    // bounded by the walk, not erased by it.
    expect(
      await signInAndReadSession("user-off-chain", "203.0.113.7, 192.0.2.9"),
    ).toBe("192.0.2.9");
  });

  it("does not name a trusted hop as the client when every hop is one", async () => {
    // The invariant, whatever the fallback: a hop on the trusted list must
    // never end up recorded as the person who signed in. In a test process
    // better-auth then answers its localhost fallback for the walk that
    // yielded nothing; in a hardened one it would be the empty column the
    // shared "no-trusted-ip" rate-limit bucket is named after.
    const ip = await signInAndReadSession(
      "user-all-trusted",
      "10.0.0.1, 10.0.0.2",
    );
    expect(ip).not.toBe("10.0.0.1");
    expect(ip).not.toBe("10.0.0.2");
    expect(ip).toBe("127.0.0.1");
  });

  it("falls back to the runtime address without a header", async () => {
    // The baseline the chains stand against: in a test environment better-auth
    // answers with localhost, the way it does in development, instead of
    // refusing to name an address at all.
    expect(await signInAndReadSession("user-no-chain")).toBe("127.0.0.1");
  });
});

describe("the throttler bucket behind a trusted proxy", () => {
  /** The short-tier budget as the request behind the named chain sees it. */
  async function status(forwardedFor: string): Promise<number> {
    const response = await fetch(`${fx.baseUrl}/health`, {
      headers: { "x-forwarded-for": forwardedFor },
    });

    return response.status;
  }

  it("keys the budget on the client address past every trusted hop", async () => {
    // Two proxies (a CDN then a load balancer, both in 10.0.0.0/8) stand in
    // front of two different callers. A single hop of trust names the CDN as
    // the client and collapses the two into one bucket; the named list walks
    // past both proxies and the second caller keeps a budget of its own.
    for (let i = 0; i < 5; i++) {
      expect(await status("203.0.113.7, 10.0.0.2, 10.0.0.1")).toBe(200);
    }
    expect(await status("203.0.113.7, 10.0.0.2, 10.0.0.1")).toBe(429);

    expect(await status("198.51.100.9, 10.0.0.2, 10.0.0.1")).toBe(200);
  });
});
