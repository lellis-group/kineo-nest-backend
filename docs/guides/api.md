# API

[Documentation index](../README.md) - [Getting started](getting-started.md) - [Configuration](configuration.md)

## Swagger

Swagger UI is served at `/api` in development and test only. It declares a bearer scheme.

1. Call `POST /api/auth/sign-in/email`.
2. Read the token from the `set-auth-token` response header.
3. Paste it into **Authorize** in the UI to use **Try it out** on protected routes.

The token is accepted because better-auth runs its `bearer()` plugin. Without the plugin, the global `AuthGuard` only reads the session cookie. OpenAPI schemas are generated from the Zod DTOs by `nestjs-zod`; date fields exposed to Swagger must use `z.iso.datetime()` because plain `z.date()` breaks OpenAPI generation with Zod v4.

## Route map

The table lists route families. The authoritative, complete list is the OpenAPI document served at `/api-json`.

| Prefix | Purpose |
|---|---|
| `/api/auth/*` | better-auth endpoints: sign up, sign in, sessions, verification, reset, email change |
| `/` | Root, public |
| `/ping`, `/health` | Liveness; `/health?deep=1&token=...` adds readiness when a token is configured |
| `/profile` | Profile CRUD, `/me`, public directory, `/:id` |
| `/practices` | Practice CRUD, `/mine`, geo search, `/:id` |
| `/replacement-listings` | Listing CRUD, `facets`, `places`, `page-of`, `mine`, `publish`, `close`, `cancel` |
| `/applications` | Apply, shortlist, accept, reject, withdraw, view tracking, CV attachment |
| `/files` | Uploads for avatar, CV, listing images; streaming and deletion |
| `/account/confirm-deletion` | Anonymous erasure confirmation with an emailed token |

### Authentication expectations

Every read route requires a session: the browse feed (`/replacement-listings`, `facets`, `places`, `page-of`, `/:id`) and the directories (`/profile`, `/profile/:id`, `/practices`, `/practices/:id`) included. Besides better-auth's own `/api/auth/*` routes, only `/`, `/ping`, `/health`, and the erasure confirmation opt out.

The feed is therefore sent `Cache-Control: private`, so no shared cache stores it. A public profile's coordinates are rounded to two decimals; the exact values remain on the owner's `GET /profile/me`.

The two file read routes are the exception: they use `@OptionalAuth()`. Avatars and photos of a public listing reach anonymous readers; CVs and private or closed listings answer 404 without the owner's session.

### Email verification endpoint

`GET /api/auth/check-email-verification?token=...` is a custom better-auth endpoint. Given a verification token, even an expired or already used one, it reports whether the account is already verified. It lets the frontend show a success screen when a user clicks an old email link again.

## Listing reads

| Parameter | Behavior |
|---|---|
| `specialty`, `city` | Filters on the applicable set: `OPEN` and `IN_DISCUSSION` |
| `sort` | `recent`, `urgent`, or `startDate`; orders the whole collection before paging |
| `facets` | Per-specialty counts for the same applicable set |
| `places` | Map places, bounded by `MAX_BROWSE_MAP_PLACES`, with a `truncated` flag |
| `page-of` | Locates a listing within a sorted result set |

> **Note** - Every list endpoint orders by `createdAt` and then `id`. `createdAt` is not unique, and offset pagination over a non-total order repeats and skips rows; the `id` tiebreak is what makes pages stable. The browse feed's applicable set differs from the wider owner-console set on purpose. See [Conventions](../reference/conventions.md).

## Error semantics

Ownership failures on private resources answer 404 rather than 403, to avoid resource enumeration. Validation errors come from Zod DTOs with length, range, coordinate, and RPPS format constraints. Throttling is applied per route through the tiers described in [Configuration](configuration.md#rate-limiting).
