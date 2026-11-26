# Configuration

[Documentation index](../README.md) - [Getting started](getting-started.md) - [API](api.md)

All settings come from environment variables, with `.env.example` as the reference file. Missing `NODE_ENV` means production, so the gates close by default rather than by intent. Set it to `development` or `test` to open Swagger, secure-cookie handling, and detailed error bodies.

## Core

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string; also the single connection pool |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | production when absent | `development` or `test` opens the development gates |
| `BETTER_AUTH_SECRET` | required | At least 32 characters; signs better-auth tokens and derives erasure fingerprints |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public base URL of the auth server |
| `FRONTEND_URL` | `http://localhost:3001` | Used to rewrite auth email links to frontend pages |
| `TRUSTED_ORIGINS` | `http://localhost:3001` | CORS allowlist |
| `SHADOW_DATABASE_URL` | - | Throwaway database used by `db:check`; emptied on every run |
| `TEST_DATABASE_ADMIN_URL` | - | Admin URL used by e2e suites to create and drop their own databases |
| `HEALTH_DEEP_TOKEN` | unset | Enables `/health?deep=1&token=...`; without it, `/health` is liveness only |
| `DATABASE_POOL_MAX` | pg default (10) | Ceiling of the pool shared by the app and better-auth |
| `PRISMA_LOG_QUERIES` | `false` | Diagnostic only: one line per statement |

> **Note** - Size the pool with replicas in mind: N replicas at max M are N x M connections against the database's `max_connections`.

## Authentication and sessions

| Variable | Default | Notes |
|---|---|---|
| `JWT_ENABLED` | `false` | Enables the optional better-auth bearer plugin |
| `JWT_EXPIRATION_TIME` | `15m` | Token lifetime |
| `JWT_ROTATION_INTERVAL` | `2592000` | Rotation interval in seconds |
| `SESSION_EXPIRES_IN` | `604800` | Session lifetime in seconds |
| `SESSION_UPDATE_AGE` | `86400` | Session refresh threshold in seconds |
| `REQUIRE_EMAIL_VERIFICATION` | true outside development and test | Turn off only after reading the cost: new accounts then sign in without clicking their link |
| `COOKIE_CACHE_ENABLED` | `false` | Caches the session and user row in a signed cookie; enable only with a `version` function |
| `COOKIE_CACHE_MAX_AGE` | `300` | Cached cookie lifetime in seconds |

> **Warning** - With cookie caching on, better-auth bakes the user row into a signed cookie and only a `version` function invalidates it. This project does not register one, so an anonymized or re-verified row would keep being served from the cookie.

## Rate limiting

Three throttler tiers are declared once in `config/configuration.ts` and applied per route through `common/throttle.ts`. A fourth `deletion` tier is registered but refused by the guard unless a route opts in, so its budget cannot leak onto the rest of the API.

| Tier | Window variable | Limit variable | Default |
|---|---|---|---|
| short | `THROTTLE_SHORT_TTL` | `THROTTLE_SHORT_LIMIT` | 5 per 1000 ms |
| medium | `THROTTLE_MEDIUM_TTL` | `THROTTLE_MEDIUM_LIMIT` | 30 per 10000 ms |
| long | `THROTTLE_LONG_TTL` | `THROTTLE_LONG_LIMIT` | 150 per 60000 ms |
| deletion | `THROTTLE_DELETION_TTL` | `THROTTLE_DELETION_LIMIT` | 5 per 900000 ms |

Other limits:

| Variable | Notes |
|---|---|
| `RATE_LIMIT_WINDOW`, `RATE_LIMIT_MAX` | General-rate-limit defaults |
| `CREDENTIAL_RATE_LIMIT_WINDOW`, `CREDENTIAL_RATE_LIMIT_MAX` | Overrides better-auth's own 3-per-10s rule on sign-in and sign-up |
| `CHANGE_EMAIL_RATE_LIMIT_WINDOW`, `CHANGE_EMAIL_RATE_LIMIT_MAX` | Overrides better-auth's email-change limit; looser because the change sends two emails |
| `REDIS_URL` | Optional; makes both the throttler and better-auth count buckets in shared Redis |

<details>
<summary>Proxy address resolution</summary>

Every request reaches this API through the Next.js frontend, both through its `/api` proxy and through server-side reads. `TRUST_PROXY` says that a proxy is present; `TRUST_PROXY_IPS` lists the proxies themselves as addresses or CIDR ranges. better-auth walks the forwarded-for chain right to left, skips those hops, and takes the first untrusted address as the client IP. The same list is Express's `trust proxy` setting, so the throttler resolves the same client.

Without that list, a two-hop chain resolves to no client at all and every such caller collapses into one shared bucket. Use the real proxy addresses: a range that also covers clients lets a caller choose its own address by appending enough hops. The frontend forwards `X-Forwarded-For` as received, so the reverse proxy in front of it must overwrite the header.

</details>

## Resource caps and content limits

| Variable | Default | Notes |
|---|---|---|
| `MAX_PRACTICES_PER_PROFILE` | `5` | Practices a profile may own |
| `MAX_ACTIVE_LISTINGS_PER_PROFILE` | `10` | Simultaneously active listings |
| `MAX_ACTIVE_APPLICATIONS_PER_PROFILE` | `20` | Active applications |
| `MAX_BROWSE_MAP_PLACES` | `200` | Practices drawn on the browse map; the response flags truncation |

## Mail

| Variable | Notes |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Default `localhost:1025`, the Mailpit container |
| `SMTP_FROM` | Default `Kineo <noreply@localhost>` |
| `SMTP_SECURE` | TLS mode |
| `SMTP_USER`, `SMTP_PASS` | All-or-nothing: set both or neither |

Delivery failures are handled without blocking the business transaction. Templates escape their interpolations and refuse a call to action whose target is not http(s). No plaintext token is logged.

## Account erasure

| Variable | Notes |
|---|---|
| `DELETION_PEPPER` | HMAC key, at least 32 characters; required outside development and test |
| `ACCOUNT_PURGE_GRACE_DAYS` | Delay between anonymization and final deletion |
| `DATA_DELETION_REQUEST_RETENTION_DAYS` | Retention of the executed audit trail |
| `PENDING_DELETION_REQUEST_RETENTION_DAYS` | Retention of an unconfirmed request; minimum 2, because the link lives 24 hours |
| `THROTTLE_DELETION_TTL`, `THROTTLE_DELETION_LIMIT` | Throttle for the anonymous confirmation endpoint |

> **Warning** - Back up `DELETION_PEPPER` with the database. Losing it does not erase the audit trail, it makes the trail unreachable: no one can compute the fingerprint to search for. See [Account erasure](../operations/account-erasure.md).

## File storage

One switch selects the driver.

| Variable | Notes |
|---|---|
| `STORAGE_DRIVER` | `local` or `s3` |
| `STORAGE_ROOT` | Target folder for `local`; used by development and every test suite |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | Target store, typically RustFS locally |
| `S3_FORCE_PATH_STYLE` | Required by RustFS and MinIO unless virtual-host domains are configured |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Development defaults ship in `.env.example`; a hardened environment refuses that pair |
| `FILES_MAX_AVATAR_BYTES` | Default 2 MiB |
| `FILES_MAX_IMAGE_BYTES` | Default 5 MiB |
| `FILES_MAX_IMAGES_PER_LISTING` | Default 5 |
| `FILES_MAX_CV_BYTES` | Default 10 MiB |

Behavior worth knowing before changing this area:

- Uploads are validated by magic number in `uploadToDisk()` before a byte is committed, and bounded by the per-kind ceilings enforced by Multer.
- Objects are private and served only through `GET /files/:id` via `serveFile()`.
- The two read routes use `@OptionalAuth()`: avatars and photos of a public listing stream to anonymous readers; CVs and private or closed listings answer 404 without the owner's session. Every other route keeps the global `AuthGuard`.
- Use an object store in production. A container's local disk vanishes when the task is replaced, and `STORAGE_DRIVER=local` refuses to boot in a hardened environment.
- Grant only `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` on the bucket. Without `ListBucket`, a missing key answers 403 instead of 404.

For a local S3 run, start RustFS with `docker compose --profile s3 up -d rustfs` (S3 API on 9000, console on 9001), then run `bun run files:bucket` once.
