import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun ./prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
    // Only read by `prisma migrate diff --from-migrations`, which replays the
    // migration history into a throwaway database to compare it against the
    // datamodel. CI sets it to prove the two have not drifted.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
