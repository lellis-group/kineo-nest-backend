# Security and reliability

[Documentation index](../README.md) - [Testing and CI](testing.md) - [Configuration](../guides/configuration.md)

The design choices below are resolved and reflected in the code and tests. They are described as they stand, not as intentions.

## Access control

Ownership is checked on every mutating route across all four business modules. Private resources answer 404 rather than 403, so a caller cannot enumerate identifiers through the status code.

## Concurrency

| Situation | Mechanism |
|---|---|
| Application limits, listing capacity, accept/reject cascades | `Serializable` isolation with automatic retry in `common/serializable-transaction.ts` |
| Shortlist and message edits driven directly by the frontend | Optimistic compare-and-set: the write carries the expected status in its `where`; zero affected rows means the decision changed in between |
| Shortlist versus accept | Pinned over HTTP in `applications-transitions.e2e.test.ts` |

The split is deliberate: the raw relations are fast paths that never share a counter, while the cascades touch rows several writers can contend for.

## One database client

The application and better-auth serve every read and write from a single `PrismaService` instance provided by `PrismaModule`. `DATABASE_POOL_MAX` states what a replica costs against PostgreSQL's `max_connections`, since the pg default of 10 used to apply per client when there were three of them. Standalone auth scripts call `createStandaloneAuth()` on first use, never at import.

## Rate limiting

Multi-tier throttling is declared once in `config/configuration.ts` and applied per route through `common/throttle.ts`, with proxy-aware IP tracking. A fourth `deletion` tier is registered but refused by the guard unless the route opted in, so its budget cannot leak onto the rest of the API. better-auth's own 3-per-10s rule on credential endpoints is overridden by `CREDENTIAL_RATE_LIMIT_*`.

<details>
<summary>How client IPs are resolved behind the frontend proxy</summary>

On the auth routes Express never sees, better-auth resolves the client itself: the proxies are named in `TRUST_PROXY_IPS`, and the same list drives Express's `trust proxy` setting so the throttler's `req.ip` resolves the same client. Without it, a two-hop `X-Forwarded-For` chain resolves to no client at all and every such caller collapses into one shared bucket.

When `REDIS_URL` is set, both layers count their buckets in shared Redis through `lib/auth/rate-limit-redis.ts` and `ThrottlerStorageRedisService`, so N replicas enforce one budget instead of N.

</details>

## Account erasure

`deleteUser.beforeDelete` refuses better-auth's hard delete. The only path is anonymization, documented in [Account erasure](account-erasure.md). Verification-token purge, ghost listings, and the keyed trail are covered by the e2e suite, not only by fakes.

## Input validation

Length and range constraints are applied on every Zod DTO: text fields are capped, coordinates bounded, and RPPS format checked. Per-profile resource caps are configurable through `MAX_PRACTICES_PER_PROFILE`, `MAX_ACTIVE_LISTINGS_PER_PROFILE`, and `MAX_ACTIVE_APPLICATIONS_PER_PROFILE`.

## Transport and email

- Helmet with a CSP scoped to allow the Scalar-based Swagger UI.
- CORS restricted to `TRUSTED_ORIGINS`.
- No plaintext token logging.
- Real SMTP delivery, TLS aware, with error handling that never blocks the underlying business transaction.
- Every HTML template escapes its interpolations and refuses a call to action whose target is not http(s).

## Indexes

Composite and partial indexes are aligned with actual query patterns: status-filtered lookups on listings and applications, and bounding-box geo search on practices. The deliberately unindexed listing reads are measured by `bun run profile`; see [Testing and CI](testing.md).

## Accepted risks

The following are known exposures, not defects this repository can fix on its own.

| Area | Exposure | Mitigation |
|---|---|---|
| `verification` | Password-reset and account-deletion tokens are stored in clear text. Email-verification tokens are signed JWTs instead, so they are not there. | Encryption at rest and restricted database-role access. Anyone who can read that table can reset a password or confirm a deletion: that is a database-read capability. |
| `Session.token` | Same class of exposure as the tokens above. | Bounded by the same hourly sweep. |
| `account` | Holds better-auth password hashes, reachable by the same database role. | scrypt cost and `minPasswordLength: 8`. |

The hourly sweep in `data-lifecycle.service.ts`, under an advisory lock, is what bounds the token window: a token that is never read still expires. See [Account erasure](account-erasure.md).
