/**
 * End-to-end harness for the account-erasure path.
 *
 * The unit tests call the service with a hand-written fake, which is fast and
 * precise but proves nothing about the wiring: the real `P2003` this suite was
 * added after came from a foreign key on a table nobody had seeded, and no
 * fake would ever have shown it. So these tests boot the actual `AppModule`,
 * listen on an ephemeral port, and talk to it over HTTP.
 *
 * They also run against their own database. `confirmDeletion` eventually
 * deletes the account row outright, which is the point of the endpoint and also
 * makes it impossible to run twice against the same data — and unacceptable
 * against a developer's own fixtures. The database is created, migrated and
 * dropped around the suite, so the assertions can be about end state rather
 * than about a mock's bookkeeping.
 */

import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import { SYSTEM_SCAFFOLD } from "../../common/system-scaffold";

/**
 * Name of the throwaway database this process owns.
 *
 * Derived from `KINEO_E2E_SUITE`, which `package.json` sets per suite, so the
 * three suites that `test:e2e` runs in three separate processes each create
 * their own. They used to share one name, and `bun test src` — which loads
 * every spec in a single process — had two of them race between
 * `DROP DATABASE IF EXISTS` and `CREATE DATABASE`, which surfaced as
 * `duplicate key value violates unique constraint "pg_database_datname_index"`.
 * Distinct names remove the race entirely rather than papering over it.
 *
 * `TEST_DATABASE_NAME` still wins, so a developer can point one run at a
 * database of their own to inspect what a suite left behind.
 */
const TEST_DB =
  process.env.TEST_DATABASE_NAME ??
  `kineo_e2e_${process.env.KINEO_E2E_SUITE ?? "default"}`;
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://johndoe:randompassword@localhost:5432/postgres";

/**
 * Credentials of the developer's own database, so the throwaway one accepts the
 * same user. The pathname is cleared by rebuilding the URL without it — setting
 * `pathname = ""` leaves a bare `/`, which PostgreSQL reads as a zero-length
 * quoted identifier.
 */
function credentialsFromEnv(): string {
  const raw = (process.env.DATABASE_URL ?? "").trim();
  if (!raw) {
    throw new Error("DATABASE_URL is required to run the e2e suite");
  }
  const url = new URL(raw);
  return `${url.protocol}//${url.username}:${url.password}@${url.host}`;
}

function urlFor(database: string): string {
  const query = new URL(process.env.DATABASE_URL ?? "").search;
  return `${credentialsFromEnv()}/${database}${query}`;
}

const TEST_DATABASE_URL = urlFor(TEST_DB);

/**
 * `prisma db execute` reads its URL from the config file and refuses `--url`,
 * so the database lifecycle is driven through a plain `pg` client instead. One
 * less indirection, and the same driver the assertions use.
 */
async function runAs(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function dropIfExists(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Terminate leftovers first: a previous run that was killed mid-suite leaves
  // live connections, and DROP DATABASE would then block or fail.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  await admin.end();
}

export interface E2EFixture {
  app: INestApplication;
  baseUrl: string;
  url: string;
  prisma: import("../../generated/prisma/client").PrismaClient;
}

let fixture: E2EFixture | null = null;

/** Boots the app against a throwaway database. Idempotent across calls. */
export async function bootApp(): Promise<E2EFixture> {
  if (fixture) {
    return fixture;
  }

  // These suites need their own process.
  //
  // The erasure is a `Serializable` transaction on a single-use token, and the
  // concurrency test relies on two requests genuinely racing — which they do
  // not when a neighbouring unit file loads the service graph first in the same
  // process, because `lib/prisma.ts` then binds its adapter to the developer's
  // database before a line below can be read. The e2e would silently assert
  // against the wrong database: writes in one file, reads in another.
  //
  // Bun runs test files in one process, so this cannot be fixed from inside a
  // spec. `package.json` runs them apart, and this guard turns the resulting
  // mistake into an error instead of a red herring.
  if (process.env.KINEO_E2E) {
    throw new Error("this suite must run on its own: `bun run test:e2e`");
  }
  process.env.KINEO_E2E = "1";

  await dropIfExists();
  await runAs(ADMIN_URL, `CREATE DATABASE "${TEST_DB}"`);

  // The whole app reads DATABASE_URL at import time (`lib/prisma.ts` builds its
  // adapter eagerly), so it has to be set before anything is imported. The
  // modules under test are then imported dynamically for the same reason.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  // Outside development/test the pepper must be its own secret; here the audit
  // trail only needs a stable value so the hashes a test writes can be
  // recomputed by the service under test.
  process.env.DELETION_PEPPER = "e".repeat(64);
  process.env.BETTER_AUTH_SECRET = "s".repeat(64);
  process.env.BETTER_AUTH_URL = "http://localhost:3001";
  // The deletion tier is 5 attempts per 15 minutes, which the production limit
  // for good reason: the endpoint is anonymous and the token is the only proof
  // of identity. The suite makes a dozen of them, so it would spend its budget
  // on its own first tests and every later one would see a 429. Raised here
  // rather than relaxed in `configuration.ts`, so the shipped value stands.
  process.env.THROTTLE_DELETION_LIMIT = "1000";
  process.env.THROTTLE_DELETION_TTL = "60000";
  // Same reasoning for better-auth's own limiter. Its `RATE_LIMIT_*` do not
  // reach the credential endpoints, which carry a hardcoded 3-per-10s rule; a
  // suite that signs in once per test spends that on itself and a later test
  // gets a 429 unrelated to what it asserts.
  process.env.CREDENTIAL_RATE_LIMIT_WINDOW = "60";
  process.env.CREDENTIAL_RATE_LIMIT_MAX = "10000";

  // `prisma.config.ts` resolves its datasource through `env("DATABASE_URL")`,
  // and `dotenv/config` — which it imports — only fills variables that are not
  // already set. So the value written above is what the CLI picks up, and
  // migrating against the developer's own database is not reachable from here.
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env },
    stdio: "pipe",
  });

  // Imported dynamically, and only now. `lib/prisma.ts` builds its adapter at
  // module scope from `process.env.DATABASE_URL`, so a static import of
  // anything that reaches it — `app.ts` included — would capture the developer's
  // own database before the line above runs. The whole graph has to come up
  // after the environment is set, or the app silently talks to `mydb` while the
  // assertions read the throwaway one.
  //
  // `createApp()` rather than a `Test.createTestingModule` over `AppModule`: the
  // latter built a bare Nest application with none of the middleware the server
  // runs — no helmet, no compression, no CORS, no `trust proxy`, no Swagger gate.
  // This suite was described as booting the real application, and it was not.
  const { createApp } = await import("../../app");
  const app = await createApp();
  app.enableShutdownHooks();

  // `getHttpAdapter().getInstance()` is the Nest application, not the Node
  // server, so the address has to come from `app.listen` itself. Port 0 lets the
  // OS pick a free one, which keeps the suite from colliding with a dev server.
  await app.listen(0, "127.0.0.1");
  const baseUrl = await app.getUrl();

  const { createPrismaClient } = await import("../../lib/prisma");
  const prisma = createPrismaClient();

  // The scaffold the ghost listings hang from, created by the migration. The
  // assertions below read these ids, so a missing row fails loudly rather than
  // making the detachment look like a no-op.
  const scaffold = await prisma.practice.findUnique({
    where: { id: SYSTEM_SCAFFOLD.practiceId },
    select: { id: true },
  });
  if (!scaffold) {
    throw new Error(
      "the system scaffold is missing: prisma migrate deploy did not run",
    );
  }

  fixture = { app, baseUrl, url: TEST_DATABASE_URL, prisma };
  return fixture;
}

export async function shutdownApp(): Promise<void> {
  if (!fixture) {
    return;
  }
  const { app, prisma } = fixture;
  fixture = null;
  await app.close();
  await prisma.$disconnect();
  await dropIfExists();
}

/** Truncates every table the erasure path touches, scaffold included by name. */
export async function resetData(prisma: E2EFixture["prisma"]): Promise<void> {
  await prisma.application.deleteMany({});
  await prisma.replacementListing.deleteMany({
    where: { practiceId: { not: SYSTEM_SCAFFOLD.practiceId } },
  });
  await prisma.practice.deleteMany({
    where: { id: { not: SYSTEM_SCAFFOLD.practiceId } },
  });
  await prisma.profile.deleteMany({
    where: { id: { not: SYSTEM_SCAFFOLD.profileId } },
  });
  await prisma.account.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.verification.deleteMany({});
  await prisma.dataDeletionRequest.deleteMany({});
  await prisma.user.deleteMany({
    where: { id: { not: SYSTEM_SCAFFOLD.userId } },
  });
}

export const SYSTEM = SYSTEM_SCAFFOLD;
