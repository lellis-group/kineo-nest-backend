import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Throttles on the client address, and on the erasure token where there is one.
 *
 * `ThrottlerGuard`'s stock tracker is the remote address, which is the wrong key
 * for `POST /account/confirm-deletion`: that endpoint is anonymous, and the token
 * is the only proof of identity. Behind a reverse proxy with `trust proxy` off —
 * the shipped default — every caller shares one address, so the whole platform
 * shares one budget and a handful of requests from a single host locks every
 * user's right to erasure under art. 17 for the length of the window. Adding the
 * token to the key separates those budgets: a legitimate holder spends only their
 * own, and a flood of guessed tokens cannot consume anyone else's.
 *
 * The address stays in the key so one host cannot send unbounded distinct tokens.
 * The token is hashed rather than used as-is, because the key is what a storage
 * backend would keep.
 */
@Injectable()
export class TokenAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const client = clientAddress(req);

    if (!isErasureRequest(req)) {
      return client;
    }

    const token = erasureToken(req);

    return token ? `${client}|${hashToken(token)}` : client;
  }
}

/**
 * The address to attribute a request to.
 *
 * `req.ip` is where the walk over the forwarded chain stopped: the first
 * address not on the trusted list, or the runtime address when trust proxy is
 * off. The list names the proxies (`TRUST_PROXY_IPS`, `src/app.ts`), so an
 * untrusted caller prefixed to `X-Forwarded-For` only ever names itself, and
 * two callers behind the same chain resolve to two addresses.
 */
export function clientAddress(req: Record<string, unknown>): string {
  return typeof req.ip === "string" ? req.ip : "unknown";
}

function isErasureRequest(req: Record<string, unknown>): boolean {
  const url = requestUrl(req);

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

  const url = requestUrl(req);
  if (typeof url !== "string") {
    return undefined;
  }

  // Matched on the whole URL: requiring a leading ? or & on the sliced query
  // misses the first parameter, which is the only one most callers send.
  const match = /[?&]token=([^&#]*)/.exec(url);
  const value = match?.[1];

  return value ? decodeURIComponent(value).trim() : undefined;
}

function requestUrl(req: Record<string, unknown>): unknown {
  return req.originalUrl ?? req.url;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
