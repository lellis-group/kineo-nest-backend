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
});
