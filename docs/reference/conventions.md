# Conventions

[Documentation index](../README.md) - [AI takeover notes](ai-takeover.md)

Rules and facts that are not obvious from reading a single file.

## Migrations

Nothing checks a migration that was hand-edited or renamed. `bun run db:check` is the gate and it runs in CI. Never give a migration folder a hand-picked timestamp: a name dated in the future sorts before everything generated after it, and the replay fails.

`prisma/schema.prisma` uses `previewFeatures = ["partialIndexes"]`. The partial unique indexes behind the one-pending-request-per-fingerprint rule depend on it. It is production code on a preview flag, so read the release notes at every Prisma upgrade before touching it.

## E2e isolation

Run e2e suites with `bun run test:e2e`. Running `bun test src` collects them too, and they refuse to share a process with anything else. The whole application reads `DATABASE_URL` at import time, so a suite loaded after a unit spec would silently assert against the developer's own database.

## Ordering and pagination

Every list endpoint orders by `createdAt` and then `id`. `createdAt` is not unique, and offset pagination over a non-total order repeats and skips rows. Keep the `id` tiebreak on any new list endpoint.

## The browse feed

The browse feed answers the *applicable* set: `OPEN` and `IN_DISCUSSION`, which are the statuses `applications.create` accepts. The same set drives the facets, the map, and the direct link. A `FULL` posting is out by construction. `RECRUITING_LISTING_STATUSES` is the wider console set; the gap between the two is a product decision, not a bug.

## Read-route authentication

Every read route requires a session, including the feed (`/replacement-listings`, `/facets`, `/places`, `/page-of`, `/:id`) and the directories (`/profile`, `/profile/:id`, `/practices`, `/practices/:id`). Besides better-auth's own `/api/auth/*` routes, only `/`, `/ping`, `/health`, and the erasure confirmation opt out.

Two consequences to preserve:

- The feed is sent `Cache-Control: private`, so no shared cache stores it.
- A public profile's coordinates are rounded to two decimals, about one kilometre. A profile is a person; the exact values stay on the owner's `GET /profile/me`.

## Email notifications

Templates and the mailer exist, but status-change notifications are not wired into `ApplicationsService` yet. The intended home is a dedicated `NotificationsModule`; see the [Roadmap](../product/roadmap.md).

## Related reading

- [Architecture overview](../architecture/overview.md) for layering rules.
- [Testing and CI](../operations/testing.md) for the full gate list.
- [Account erasure](../operations/account-erasure.md) for the trail and sweep behavior.
