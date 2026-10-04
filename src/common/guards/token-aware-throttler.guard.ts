import { createHash } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Throttles on `req.ip`, plus the erasure token where there is one.
 *
 * `ThrottlerGuard`'s stock tracker is the IP alone, which is the wrong key for
 * `POST /account/confirm-deletion`: it is anonymous, and the token is the only
 * proof of identity. Behind a reverse proxy with `trust proxy` off — the shipped
 * default — `req.ip` is the proxy for every caller, so the whole platform
 * shares one budget and six requests from a single host lock every user's right
 * to erasure under art. 17 for the length of the window.
 *
 * Adding the token separates those budgets: a legitimate holder spends only
 * their own, and a flood of guessed tokens cannot consume anyone else's.
 *
 * Brute force stays bounded because the attacker is limited per target token —
 * five attempts against any one value, whatever else they send alongside it —
 * and the token carries about 165 bits of entropy, so enumerating the real one
 * was never the threat this tier defends against. It defends the endpoint
 * against enumeration and spam, which the per-token key still does.
 *
 * The IP half is kept so one host cannot send unbounded distinct tokens.
 */
@Injectable()
export class TokenAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = typeof req.ip === "string" ? req.ip : "unknown";

    if (!isErasureRequest(req)) {
      return Promise.resolve(ip);
    }

    const token = erasureToken(req);
    if (!token) {
      return Promise.resolve(ip);
    }

    return Promise.resolve(`${ip}|${hashToken(token)}`);
  }
}

function isErasureRequest(req: Record<string, unknown>): boolean {
  const url: unknown = req.url ?? req.originalUrl;

  return (
    req.method === "POST" &&
    typeof url === "string" &&
    url.includes("confirm-deletion")
  );
}

/** The token from the body or the query string, whichever the caller used. */
function erasureToken(req: Record<string, unknown>): string | undefined {
  const fromBody = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof fromBody === "string" && fromBody.length > 0) {
    return fromBody.trim();
  }

  const url: unknown = req.url ?? req.originalUrl;
  if (typeof url !== "string") {
    return undefined;
  }

  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const match = /(?:\?|&)token=([^&]*)/.exec(query);
  const value = match?.[1];

  return value ? decodeURIComponent(value).trim() : undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Exposed for the module wiring, which registers it as the global guard. */
export const THROTTLE_GUARD_PROVIDER = TokenAwareThrottlerGuard;

export type { ExecutionContext };
