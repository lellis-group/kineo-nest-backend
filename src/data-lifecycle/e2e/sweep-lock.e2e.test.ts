/**
 * The sweep lock, released.
 *
 * The lock used to be taken and released by two statements the connection pool
 * was free to route to two different connections. When that happened the release
 * did nothing, the lock stayed held, and every sweep after the first one skipped
 * — which a unit test with a fake client cannot see. Two sweeps over HTTP, on a
 * real pool, can.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootApp,
  type E2EFixture,
  shutdownApp,
} from "../../common/e2e/harness";
import { SYSTEM_SCAFFOLD } from "../../common/system-scaffold";
import type { DataLifecycleService } from "../data-lifecycle.service";

let fx: E2EFixture;
let sweeper: DataLifecycleService;

async function seedExpiredSession(id: string) {
  const now = Date.now();

  await fx.prisma.session.create({
    data: {
      id,
      token: `token-${id}`,
      userId: SYSTEM_SCAFFOLD.userId,
      expiresAt: new Date(now - 60_000),
      createdAt: new Date(now - 120_000),
      updatedAt: new Date(now - 120_000),
    },
  });
}

beforeAll(async () => {
  fx = await bootApp();
  // Imported here rather than at the top: lib/prisma builds its adapter at
  // module scope, and a static import would bind it to the developer's own
  // database instead of the suite's throwaway one.
  const { DataLifecycleService: Service } = await import(
    "../data-lifecycle.service"
  );
  sweeper = fx.app.get(Service);
});

afterAll(async () => {
  await shutdownApp();
});

describe("the hourly sweep", () => {
  it("sweeps again right after itself, instead of skipping on its own lock", async () => {
    await seedExpiredSession("session-first");
    await sweeper.purgeExpired();

    expect(
      await fx.prisma.session.count({ where: { id: "session-first" } }),
    ).toBe(0);

    await seedExpiredSession("session-second");
    await sweeper.purgeExpired();

    expect(
      await fx.prisma.session.count({ where: { id: "session-second" } }),
    ).toBe(0);
  });

  // The steps catch their own errors so one table cannot hold the others back.
  // A fake client cannot tell whether that holds: on PostgreSQL a failed
  // statement aborts the transaction it runs in, and when every step shared
  // one, the next step was refused with 25P02 and its error swallowed too.
  it("still purges the other tables when one step fails", async () => {
    await seedExpiredSession("session-failing");
    await fx.prisma.verification.create({
      data: {
        id: "verification-expired",
        identifier: "someone@example.test",
        value: "token",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await fx.prisma.$executeRawUnsafe(`
      CREATE FUNCTION refuse_session_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'session delete refused by test'; END;
      $$ LANGUAGE plpgsql`);
    await fx.prisma.$executeRawUnsafe(`
      CREATE TRIGGER refuse_session_delete BEFORE DELETE ON "session"
      FOR EACH ROW EXECUTE FUNCTION refuse_session_delete()`);

    try {
      await sweeper.purgeExpired();
    } finally {
      await fx.prisma.$executeRawUnsafe(
        `DROP TRIGGER refuse_session_delete ON "session"`,
      );
      await fx.prisma.$executeRawUnsafe(
        `DROP FUNCTION refuse_session_delete()`,
      );
    }

    expect(
      await fx.prisma.session.count({ where: { id: "session-failing" } }),
    ).toBe(1);
    expect(
      await fx.prisma.verification.count({
        where: { id: "verification-expired" },
      }),
    ).toBe(0);
  });
});
