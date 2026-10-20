import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { envBoolean } from "../config/env";
import { Prisma, PrismaClient } from "../generated/prisma/client";

function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

/**
 * The connection ceiling of the shared pool, from `DATABASE_POOL_MAX`.
 *
 * The adapter takes whatever `Pool` config it is handed and creates its `pg.Pool`
 * with the library's default otherwise — `max: 10` per client. It stayed
 * implicit while there was one client; with a single shared one (AUD-015), the
 * number is what a replica costs against Postgres `max_connections`, so it is a
 * spelled-out setting rather than a library detail. Absent — local development
 * against a database sized for `max_connections` 100 and a client that connects
 * on demand — the default stands.
 */
export function resolvePoolMax(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = (env.DATABASE_POOL_MAX ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `DATABASE_POOL_MAX must be a positive integer, got: ${raw}`,
    );
  }
  return parsed;
}

/**
 * One adapter for one client. Both builders go through this, so the pool the
 * application serves its reads from and the pool scripts build are configured
 * the same way — `PrismaPg` given the connection string alone would answer with
 * its own defaults, whatever the environment said.
 */
export function createPrismaAdapter(connectionString: string): PrismaPg {
  const max = resolvePoolMax();
  return new PrismaPg(max ? { connectionString, max } : connectionString);
}

/**
 * What the client is asked to log.
 *
 * The flag only ever *adds* `query`: Prisma's own defaults are named explicitly
 * rather than left out, because passing a `log` option replaces them. Written as
 * `["query"]` when enabled and `[]` when not, as this did at first, it silenced
 * `warn` and `error` in both cases — the flag meant to help diagnose a problem
 * was what hid the warnings.
 */
export function prismaLogFor(enabled: boolean): Prisma.LogLevel[] {
  return enabled ? ["query", "warn", "error"] : ["warn", "error"];
}

/**
 * The flag, read the way every other one in this repository is read.
 *
 * Through `envBoolean`, so `TRUE` and a padded `" true "` mean the same as
 * `true`, and `1` or `yes` mean the same as absent — one definition of what a
 * boolean in this environment looks like, rather than a second one written out
 * here in an operator.
 */
export function resolvePrismaLog(
  env: NodeJS.ProcessEnv = process.env,
): Prisma.LogLevel[] {
  return prismaLogFor(envBoolean(env.PRISMA_LOG_QUERIES, false));
}

const adapter = createPrismaAdapter(resolveDatabaseUrl());

/**
 * The options for the clients built outside Nest — the seed, standalone
 * better-auth — and the defaults the Nest client starts from.
 *
 * This is evaluated once, at import. It works because the environment is in place
 * before the module graph runs, which is the only reason a flag that the
 * application reads through its configuration elsewhere could be read here at
 * all; `PrismaService` re-reads it through `ConfigService` at startup rather than
 * relying on that.
 */
export const prismaClientOptions = {
  adapter,
  log: resolvePrismaLog(),
};

export function createPrismaClient() {
  return new PrismaClient(prismaClientOptions);
}
