# Getting started

[Documentation index](../README.md) - [Configuration](configuration.md) - [API](api.md)

## Prerequisites

- A PostgreSQL database reachable at `DATABASE_URL`.
- Bun. It is the only runtime in this project; nothing in the chain spawns Node.
- For local mail: the Mailpit service from `docker-compose.yml`.
- For S3 storage: the RustFS service from `docker-compose.yml`, optional in development.

## Setup

```bash
bun install
cp .env.example .env
```

Set `DATABASE_URL` in `.env`, then start the supporting services you need:

```bash
docker compose up -d postgres mailpit
docker compose --profile s3 up -d rustfs   # only for S3 storage
docker compose up -d redis                 # only to share rate-limit buckets across replicas
```

Apply the schema and start the API:

```bash
bun run db:migrate
bun run dev
```

The API listens on `PORT`, 3000 by default. Swagger is at `/api` in development and test; see [API](api.md) for how to authenticate a request there.

## Command reference

| Command | What it does |
|---|---|
| `bun run dev` | Runs `src/main.ts` with `--watch` |
| `bun run build` | Compiles with `tsconfig.build.json`, keeping specs and e2e suites out of `dist/` |
| `bun run start` | Runs the compiled build with Bun |
| `bun run typecheck` | Type-checks `src/` and `prisma/`, specs and e2e included |
| `bun run lint` | Biome: formatting and correctness rules |
| `bun run lint:fix` | Biome with writes enabled |
| `bun run test` | Unit suites, excluding `**/e2e/**` |
| `bun run test:e2e` | Every e2e suite, each on its own throwaway database |
| `bun run test:e2e:files` | Only the upload and streaming suite; uses a local disk, no RustFS needed |
| `bun run test:all` | Unit suites followed by e2e suites |
| `bun run files:bucket` | Creates the `S3_BUCKET` bucket once on the configured S3-compatible store |
| `bun run db:migrate` | Creates and applies a migration from a change to `schema.prisma` |
| `bun run db:seed` | Wipes and repopulates; development and test only |
| `bun run db:check` | Replays the migration history and diffs it against the schema |
| `bun run profile` | Measures the two deliberately unindexed listing reads against a self-built corpus |

Individual e2e suites have their own `test:e2e:*` scripts. See [Testing and CI](../operations/testing.md).

> **Warning** - `bun run db:seed` wipes every table and recreates 40 accounts sharing one password that is committed to this repository. It refuses to run outside development and test unless `ALLOW_DESTRUCTIVE_SEED=true` is set. It is not a deployment step: the rows that account erasure parks applications on come from a migration, and `SystemScaffoldService` repairs them at boot if missing.

## Local file storage

The default `STORAGE_DRIVER=local` writes to `STORAGE_ROOT` and is what every test suite uses. For a local S3-compatible store, copy the `S3_*` values from `.env.example`, start RustFS, and run `bun run files:bucket` once. The disk expects the bucket to exist and the script creates it idempotently. See [Configuration](configuration.md) for the full driver behavior and the production constraints.

## Two TypeScript configurations

`tsconfig.json` is the base every tool reads; it covers `src/` and `prisma/` with specs included. `tsconfig.build.json` is what the build compiles, adding `rootDir`, `outDir`, and test exclusions. That split is why the build is not a bare `bun x tsc`: with the base config, specs and seed would be emitted into `dist/`.

<details>
<summary>Why the compiled build still needs Bun</summary>

`node dist/main.js` cannot run this build, and adding `.js` to every relative import would not fix it. `moduleResolution: Bundler` is a bundler-style ESM configuration, so `tsc` emits bare specifiers, and the generated Prisma client emits its own bare specifiers too. Bun resolves both.

</details>

## Next steps

- [Configuration](configuration.md) for environment variables and resource limits.
- [API](api.md) for Swagger and the route map.
- [Testing and CI](../operations/testing.md) before a pull request.
