/**
 * Minimal structured logging for domain events, on Nest's own JSON schema.
 *
 * Domain events (audit, retention sweeps, lifecycle) are emitted as single-line
 * JSON so any log pipeline (CloudWatch, Loki, Datadog…) can index them without
 * parsing. The record carries the same fields as Nest's native `ConsoleLogger`
 * with `json` and `flattenParams` on — `level`, `pid`, `timestamp`, `message`,
 * then the contextual fields spread at the root — so one pipeline reads every
 * line, Nest's and the app's, through one shape. Keep human text out of the
 * payload: machine-readable event names in `message`, contextual fields in
 * `data`.
 */

export function logEvent(event: string, data?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "log",
      pid: process.pid,
      timestamp: Date.now(),
      message: event,
      ...data,
    }),
  );
}

/**
 * Keys whose value is a credential, wherever it appears in an error.
 *
 * The names are matched case-insensitively and as substrings, so `password`,
 * `databaseUrl` and `smtpPassword` are all caught by the two first entries.
 */
const SECRET_KEYS = ["password", "databaseurl", "secret", "token"];

/**
 * A connection string, which carries its own credentials in the userinfo part.
 *
 * Matched anywhere in a string rather than only at its start: a driver is free to
 * quote it inside a sentence, and the message it prefixes is the part worth
 * keeping, so the URL is replaced in place instead of redacting the whole value.
 */
const CONNECTION_STRING = /postgres(?:ql)?:\/\/\S*/gi;

const REDACTED = "[redacted]";

/**
 * Replaces credential-bearing values, keeping the key.
 *
 * `meta.databaseUrl` on a `P1001` is the whole connection string, so logging the
 * driver error as it comes hands the Postgres password to whatever reads the log
 * — and this project's traces are single-line JSON precisely so a pipeline can
 * index them. The key is kept rather than the value: "which field held the secret"
 * is the part that makes the line debuggable.
 *
 * The message goes through here too, because a driver is free to quote the
 * connection string it failed on and `errorMessage` is called from `main.ts` on
 * the way out of a failed boot.
 */
function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEYS.some((secret) => key.toLowerCase().includes(secret))) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return value.replace(CONNECTION_STRING, REDACTED);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  }

  return value;
}

export function logError(
  event: string,
  error: unknown,
  data?: Record<string, unknown>,
): void {
  console.error(
    JSON.stringify({
      level: "error",
      pid: process.pid,
      timestamp: Date.now(),
      message: event,
      ...data,
      error: errorMessage(error),
    }),
  );
}

/**
 * The one line every log read ends up on, so it has to name the failure.
 *
 * `message` alone is not enough: Prisma puts the diagnostic in `code` and `meta`,
 * and a connection failure leaves `message` as an empty `Invalid ... invocation`
 * header. That is what made an unreachable database log as a line naming nothing.
 *
 * `message` stays first and unmodified so existing log greps keep matching, then
 * `code`, then `meta` — `meta` last because it is the bulkiest and the least
 * often what identifies the failure.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const { code, meta } = error as Error & {
    code?: unknown;
    meta?: unknown;
  };

  // A whitespace-only message would otherwise leave a leading separator behind,
  // which is what made the `ECONNREFUSED` case log as a line starting with a space.
  const parts = [String(redact(error.message)).trim()];

  if (typeof code === "string" && code.trim()) {
    parts.push(`[code=${code}]`);
  }

  if (meta !== undefined && meta !== null) {
    parts.push(JSON.stringify(redact(meta)));
  }

  return parts.filter((part) => part.length > 0).join(" ");
}
