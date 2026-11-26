# Testing and CI

[Documentation index](../README.md) - [Security and reliability](security.md) - [Getting started](../guides/getting-started.md)

Automated tests are wired into CI and are not optional.

## Suites

| Suite | Command | Scope |
|---|---|---|
| Unit | `bun run test` | `bun test`, excluding `**/e2e/**`; about 201 tests |
| E2e | `bun run test:e2e` | Every e2e suite, discovered under `src/` |
| Files only | `bun run test:e2e:files` | Upload and streaming; local disk, no RustFS needed |
| All | `bun run test:all` | Unit suites then e2e suites |

The e2e suites boot the real `AppModule` through `createApp()`, replay the migration history into a throwaway database, and drive it over HTTP. Each suite creates and drops its own database, which is why `TEST_DATABASE_ADMIN_URL` is required. Individual `test:e2e:*` scripts exist for cascade, erasure, guard, geo, change-email, account emails, input validation, applications, transitions, listings, profile, files, practices, auth guard, session cookie, body limit, proxy IP, and sweep lock.

> **Warning** - Run e2e suites with `bun run test:e2e`. Running `bun test src` collects them too, and they refuse to share a process with anything else: the whole application reads `DATABASE_URL` at import time, so a suite loaded after a unit spec would silently assert against the developer's own database.

## CI gates

Every pull request runs:

1. `prisma validate`
2. `prisma generate`
3. `build`
4. `typecheck` - covers specs and seed, unlike the build
5. `lint`
6. unit suites
7. e2e suites
8. seed
9. `bun audit --production`
10. a migration drift gate that replays the history and diffs it against `schema.prisma`

## Migration discipline

Nothing checks a migration that was hand-edited or renamed. `bun run db:check` is the gate and it runs in CI.

> **Warning** - Do not give a migration folder a hand-picked timestamp. A name dated in the future sorts before everything generated after it, and the replay fails.

## Query profiling

`bun run profile` measures the two listing reads left unindexed on purpose, using `scripts/profile-listings.ts`. It builds a throwaway corpus from `TEST_DATABASE_ADMIN_URL`; `PROFILE_PRACTICES` and `PROFILE_LISTINGS_MIN` to `PROFILE_LISTINGS_MAX` resize it. Nothing it measures is written back into the schema.

## Dependency watch

A release of `nestjs-zod` declaring `^12` peers must be upgraded and pinned with `bun test` plus the e2e suites in CI. The current combination works and is tested but is officially untested by the package. See the [Roadmap](../product/roadmap.md).
