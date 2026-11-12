import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import type { Prisma } from "../generated/prisma/client";
import { logError, logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/**
 * Default horizon for an executed erasure record (days).
 *
 * The proof of art. 5(2), kept long enough to answer a regulator's question
 * years later. Anchored on when the row was last written, not on when the request
 * was made: see the sweep.
 */
export const DELETION_REQUEST_RETENTION_DAYS = 365;

/**
 * Default horizon for a request that was never carried out (days).
 *
 * Two days is the floor, not a preference. The confirmation link is valid for 24
 * hours, so a one-day horizon sweeps the `PENDING` row while its own link is still
 * live — and every subsequent confirmation then finds no request, refuses, and the
 * account can never be erased by that link.
 */
export const PENDING_DELETION_REQUEST_RETENTION_DAYS = 30;

/** The floor above, named so the configuration and this file agree. */
export const MIN_PENDING_RETENTION_DAYS = 2;

/** Default delay between anonymizing an account and dropping its row (days). */
export const ACCOUNT_PURGE_GRACE_DAYS = 30;

/**
 * Rows deleted per statement.
 *
 * A backlog that could not be cleared in one run used to become one unbounded
 * DELETE inside the process that serves requests: a single long transaction
 * holding locks while every request queued behind it. Batching bounds both the
 * statement and the lock window.
 */
export const PURGE_BATCH_SIZE = 500;

/** Profile the ghost listings hang from. */
const GHOST_PROFILE_ID = SYSTEM_SCAFFOLD.profileId;

/** Advisory lock key for the hourly sweep, so two replicas do not overlap. */
const ACCOUNT_SWEEP_LOCK = 8_140_221;

/**
 * Scheduled retention sweeps (data minimization, art. 5(1)(e) GDPR): rows that
 * carry PII and are no longer useful must not outlive their expiry.
 *
 * - `session`: expired rows keep the session token, IP and user agent forever.
 * - `verification`: better-auth only deletes expired rows lazily, when a given
 *   identifier is read, so unread rows (abandoned sign-up, one-time links) would
 *   stay forever. They also carry the raw email as `identifier`.
 * - `user` with `deletedAt`: an anonymized account is kept for the grace period
 *   so its listings keep resolving to a real owner, then dropped for good.
 * - `dataDeletionRequest`: the accountability trail is keyed rather than readable,
 *   and dropped after a bounded horizon that depends on what the row records: an
 *   executed erasure is the art. 5(2) proof and is kept long, while a request
 *   nobody confirmed only holds the abandoned intention and goes far sooner.
 */
@Injectable()
export class DataLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(ConfigService)
    private readonly config?: ConfigService,
  ) {}

  private get accountPurgeGraceDays(): number {
    return (
      this.config?.get<number>("accountPurgeGraceDays") ??
      ACCOUNT_PURGE_GRACE_DAYS
    );
  }

  private get deletionRequestRetentionDays(): number {
    return (
      this.config?.get<number>("dataDeletionRequestRetentionDays") ??
      DELETION_REQUEST_RETENTION_DAYS
    );
  }

  private get pendingDeletionRequestRetentionDays(): number {
    return (
      this.config?.get<number>("pendingDeletionRequestRetentionDays") ??
      PENDING_DELETION_REQUEST_RETENTION_DAYS
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired() {
    const sweep: SweepRun = { skipped: false };

    await this.sweepRetention(sweep);

    // The account sweep and the ghost collection fail independently: a transient
    // error on the cascade used to skip the collection entirely, leaving orphans
    // accumulating silently for a day.
    await this.step("ghost listings", async () => {
      await this.inLockedTransaction(sweep, (tx) =>
        this.collectOrphanGhostListings(tx),
      );
    });
  }

  /**
   * One step per table, each isolated — and isolated in the database too.
   *
   * They used to share a single try: a transient error deleting sessions skipped
   * the account purge and the trail sweep with it, so a failure anywhere left the
   * most sensitive rows behind for another hour — silently, since the sweep
   * logged one line.
   *
   * Catching per step was not enough while every step ran in one transaction: on
   * PostgreSQL a failed statement aborts the transaction it belongs to, so the
   * steps after it were refused with `25P02` and the error swallowed by their own
   * catch. Each batch now commits on its own (see `inLockedTransaction`).
   */
  private async sweepRetention(sweep: SweepRun) {
    const now = new Date();
    const purged: Record<string, number> = {};

    await this.step("session", async () => {
      purged.sessions = await this.deleteInBatches(
        sweep,
        "session",
        (tx, limit) =>
          tx.session.deleteMany({
            where: { expiresAt: { lt: now } },
            limit,
          }),
      );
    });

    await this.step("verification", async () => {
      purged.verifications = await this.deleteInBatches(
        sweep,
        "verification",
        (tx, limit) =>
          tx.verification.deleteMany({
            where: { expiresAt: { lt: now } },
            limit,
          }),
      );
    });

    await this.step("anonymized account", async () => {
      purged.anonymizedAccounts = await this.deleteInBatches(
        sweep,
        "anonymized account",
        (tx, limit) =>
          tx.user.deleteMany({
            where: {
              deletedAt: {
                lte: new Date(
                  now.getTime() - this.accountPurgeGraceDays * 86_400_000,
                ),
              },
            },
            limit,
          }),
      );
    });

    // Two horizons, both anchored on `updatedAt`.
    //
    // On `createdAt` a request made 400 days ago and confirmed an hour ago was
    // swept within the hour: the account was erased and the proof of it gone, by a
    // sweep whose job was data minimization. The row's last write is what decides
    // how long it still has value — the execution for an anonymized row, the
    // abandonment for a pending one.
    //
    // And the two statuses cannot share a horizon. A `PENDING` or `SUPERSEDED` row
    // holds no proof and only the abandoned intention, so it goes far sooner; a
    // row the account was erased on is the art. 5(2) trail and goes later. It used
    // to be one step keyed on creation, which kept abandoned rows for 365 days and
    // executed ones for whatever was left of theirs.
    await this.step("deletion request never confirmed", async () => {
      const abandonedCutoff = new Date(
        now.getTime() - this.pendingDeletionRequestRetentionDays * 86_400_000,
      );
      purged.deletionRequests += await this.deleteInBatches(
        sweep,
        "deletion request never confirmed",
        (tx, limit) =>
          tx.dataDeletionRequest.deleteMany({
            where: {
              status: { in: ["PENDING", "SUPERSEDED"] },
              updatedAt: { lt: abandonedCutoff },
            },
            limit,
          }),
      );
    });

    await this.step("deletion request executed", async () => {
      const executedCutoff = new Date(
        now.getTime() - this.deletionRequestRetentionDays * 86_400_000,
      );
      purged.deletionRequests += await this.deleteInBatches(
        sweep,
        "deletion request executed",
        (tx, limit) =>
          tx.dataDeletionRequest.deleteMany({
            where: {
              status: "ANONYMIZED",
              updatedAt: { lt: executedCutoff },
            },
            limit,
          }),
      );
    });

    const total = Object.values(purged).reduce((sum, count) => sum + count, 0);

    if (total > 0) {
      logEvent("data_lifecycle.sweep", {
        ...purged,
        retentionDays: this.deletionRequestRetentionDays,
        purgeGraceDays: this.accountPurgeGraceDays,
      });
    }
  }

  private async step(label: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      logError("data_lifecycle.step_failed", error, { step: label });
    }
  }

  /**
   * Deletes in batches of `PURGE_BATCH_SIZE`, each batch in its own transaction.
   *
   * A batch that commits releases its row locks and its connection; the batches
   * used to run inside one transaction for the whole sweep, so the locks they
   * took were all held until the last step committed, and batching bounded the
   * statements without bounding the lock window it was meant to.
   */
  private async deleteInBatches(
    sweep: SweepRun,
    label: string,
    run: (
      tx: Prisma.TransactionClient,
      take: number,
    ) => Promise<{ count: number }>,
  ): Promise<number> {
    let total: number = 0;

    for (;;) {
      const result = await this.inLockedTransaction(sweep, (tx) =>
        run(tx, PURGE_BATCH_SIZE),
      );

      if (!result) {
        return total;
      }

      total += result.count;

      if (result.count < PURGE_BATCH_SIZE) {
        return total;
      }

      logEvent("data_lifecycle.batch_full", { table: label, purged: total });
    }
  }

  /**
   * Drops the ghost listings no application points at any more.
   *
   * A ghost is created per erased account and reused, so it outlives the
   * applications that were parked on it: once those authors withdraw or are
   * rejected, the row is a placeholder nobody looks at and the collections keep
   * pointing at a practice that does not exist.
   */
  async collectOrphanGhostListings(
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const orphans = await client.$queryRaw<{ id: string }[]>`
      SELECT rl."id"
      FROM "replacement_listing" rl
      WHERE rl."createdById" = ${GHOST_PROFILE_ID}
        AND NOT EXISTS (
          SELECT 1 FROM "application" a WHERE a."listingId" = rl."id"
        )`;

    if (orphans.length === 0) {
      return 0;
    }

    await client.replacementListing.deleteMany({
      where: { id: { in: orphans.map((orphan) => orphan.id) } },
    });

    logEvent("data_lifecycle.ghost_listings_collected", {
      collected: orphans.length,
    });

    return orphans.length;
  }

  /**
   * Runs `work` in a short transaction under a transaction-scoped advisory
   * lock, or skips it — and the rest of the sweep — when another replica holds
   * the lock.
   *
   * Every replica runs the same crons, so with two of them an hourly sweep ran
   * twice and the second one waited on the first one's locks for no reason.
   *
   * The lock used to be a session-level one, taken by one statement and released
   * by another, both routed through the driver's pool: nothing kept them on the
   * same connection. When they landed on two, the release did nothing, the lock
   * stayed held until its connection closed, and every sweep after that took the
   * skip branch — expired sessions, unread `verification` rows holding a raw
   * email and the erasure trail then kept their retention window indefinitely.
   * A transaction-scoped lock is released by PostgreSQL itself, on the connection
   * that took it, so the pair cannot come apart.
   *
   * Taken per transaction rather than once for the sweep: one transaction around
   * the whole sweep is what let a single failed statement abort every step after
   * it, and kept a pooled connection and its row locks for up to ten minutes.
   * Prisma's guidance is the same — keep interactive transactions short.
   */
  private async inLockedTransaction<T>(
    sweep: SweepRun,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | undefined> {
    if (sweep.skipped) {
      return undefined;
    }

    return this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ACCOUNT_SWEEP_LOCK}) AS locked`;

        if (!locked?.locked) {
          sweep.skipped = true;
          logEvent("data_lifecycle.sweep_skipped", {
            lockId: ACCOUNT_SWEEP_LOCK,
          });
          return undefined;
        }

        return work(tx);
      },
      {
        maxWait: 5_000,
        timeout: 30_000,
        isolationLevel: "ReadCommitted",
      },
    );
  }
}

/**
 * One run of the sweep. Once a transaction finds the lock held by another
 * replica, that replica owns the sweep and this run stops asking.
 */
interface SweepRun {
  skipped: boolean;
}
