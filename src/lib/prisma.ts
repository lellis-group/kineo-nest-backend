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

const adapter = new PrismaPg({
  connectionString: resolveDatabaseUrl(),
});

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
