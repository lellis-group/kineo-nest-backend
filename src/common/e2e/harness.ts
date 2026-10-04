/**
 * End-to-end harness.
 *
 * The unit tests call services with hand-written fakes, which is fast and
 * precise but proves nothing about the wiring: DI, middleware, guards and the
 * HTTP layer only exist here. These tests boot the real AppModule through
 * createApp(), listen on an ephemeral port and talk to it over HTTP.
 *
 * Each suite gets its own database, created from the migration history and
 * dropped afterwards, so a test may destroy data that a developer's fixtures
 * depend on and assertions can be about end state.
 */

import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import type { PrismaClient } from "../../generated/prisma/client";

// Derived from KINEO_E2E_SUITE, which package.json sets per suite, so suites
// run in separate processes never race between DROP and CREATE DATABASE.
// TEST_DATABASE_NAME still wins so a run can be pointed at a database to
// inspect afterwards.
const TEST_DB =
  process.env.TEST_DATABASE_NAME ??
  `kineo_e2e_${process.env.KINEO_E2E_SUITE ?? "default"}`;

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://johndoe:randompassword@localhost:5432/postgres";

/**
 * Credentials of the developer's own database, so the throwaway one accepts the
 * same role. The pathname is rebuilt rather than cleared, because
 * `pathname = ""` leaves a bare `/`, which PostgreSQL reads as a zero-length
 * quoted identifier.
 */
function credentialsFromEnv(): string {
  const raw = (process.env.DATABASE_URL ?? "").trim();
  if (!raw) {
    throw new Error("DATABASE_URL is required to run an e2e suite");
  }
  const url = new URL(raw);
  return `${url.protocol}//${url.username}:${url.password}@${url.host}`;
}

function urlFor(database: string): string {
  const query = new URL(process.env.DATABASE_URL ?? "").search;
  return `${credentialsFromEnv()}/${database}${query}`;
}

const TEST_DATABASE_URL = urlFor(TEST_DB);

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
  // A run killed mid-suite leaves live connections, and DROP DATABASE would
  // then block or fail.
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
  prisma: PrismaClient;
}

let fixture: E2EFixture | null = null;

export async function bootApp(): Promise<E2EFixture> {
  if (fixture) {
    return fixture;
  }

  // The whole application reads DATABASE_URL at import time: lib/prisma.ts
  // builds its adapter at module scope. It has to be set before anything is
  // imported, which is why the app is imported dynamically below.
  if (process.env.KINEO_E2E) {
    throw new Error("this suite must run on its own: `bun run test:e2e`");
  }
  process.env.KINEO_E2E = "1";

  await dropIfExists();
  await runAs(ADMIN_URL, `CREATE DATABASE "${TEST_DB}"`);

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.BETTER_AUTH_SECRET = "s".repeat(64);
  process.env.BETTER_AUTH_URL = "http://localhost:3001";
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  // The shipped limits are production values; a suite makes far more calls per
  // second than a human and would throttle itself.
  process.env.THROTTLE_SHORT_LIMIT = "10000";
  process.env.THROTTLE_MEDIUM_LIMIT = "10000";
  process.env.THROTTLE_LONG_LIMIT = "10000";
  process.env.RATE_LIMIT_MAX = "10000";
  process.env.CREDENTIAL_RATE_LIMIT_MAX = "10000";

  // prisma.config.ts resolves the datasource through env("DATABASE_URL") and
  // dotenv/config only fills variables that are not already set, so the value
  // written above is the one the CLI migrates.
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env },
    stdio: "pipe",
  });

  // createApp() rather than a bare testing module: the latter would run none of
  // the middleware the server runs — no helmet, no compression, no CORS, no
  // trust proxy, no Swagger gate.
  const { createApp } = await import("../../app");
  const app = await createApp();
  app.enableShutdownHooks();

  // Port 0 lets the OS pick, so a suite never collides with a dev server.
  await app.listen(0, "127.0.0.1");

  // Dynamic for the same reason as the app above: lib/prisma.ts builds its
  // adapter at module scope, so a static import would bind it to the
  // developer's own database and the assertions would read a different one than
  // the application writes.
  const { createPrismaClient } = await import("../../lib/prisma");
  const prisma = createPrismaClient();

  fixture = {
    app,
    baseUrl: await app.getUrl(),
    url: TEST_DATABASE_URL,
    prisma,
  };
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

export async function resetData(prisma: PrismaClient): Promise<void> {
  await prisma.application.deleteMany({});
  await prisma.replacementListing.deleteMany({});
  await prisma.practice.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.account.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.verification.deleteMany({});
  await prisma.dataDeletionRequest.deleteMany({});
  await prisma.user.deleteMany({});
}

/** A verified user with a credential account, ready to sign in over HTTP. */
export async function createVerifiedUser(
  prisma: PrismaClient,
  id: string,
  email: string,
  password: string,
) {
  const now = new Date();
  const { hashPassword } = await import("better-auth/crypto");

  await prisma.user.create({
    data: {
      id,
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  // better-auth matches the credential provider on accountId === userId.
  await prisma.account.create({
    data: {
      id: `account-${id}`,
      accountId: id,
      userId: id,
      providerId: "credential",
      password: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    },
  });

  return { id, email };
}

export async function signIn(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (response.status !== 200) {
    throw new Error(
      `sign-in failed (${response.status}): ${await response.text()}`,
    );
  }

  return response.headers.get("set-cookie") ?? "";
}
