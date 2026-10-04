import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import { logError, logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** Default retention horizon for the account-deletion audit trail (days). */
export const DELETION_REQUEST_RETENTION_DAYS = 365;

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
 * - `dataDeletionRequest`: the accountability trail is keyed rather than
 *   readable, and it is dropped after a bounded horizon regardless of status: a
 *   PENDING row means the 24h token window passed without confirmation, so it no
 *   longer holds any value either.
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

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired() {
    await this.withAdvisoryLock(ACCOUNT_SWEEP_LOCK, () => this.runSweep());
  }

  /**
   * The account sweep and the ghost collection fail independently: a transient
   * error on the cascade used to skip the collection entirely, leaving orphans
   * accumulating silently for a day.
   */
  private async runSweep() {
    await this.sweepRetention();
    await this.collectOrphanGhostListings();
  }

  /**
   * One step per table, each isolated.
   *
   * They used to share a single try: a transient error deleting sessions skipped
   * the account purge and the trail sweep with it, so a failure anywhere left the
   * most sensitive rows behind for another hour — silently, since the sweep
   * logged one line.
   */
  private async sweepRetention() {
    const now = new Date();
    const purged: Record<string, number> = {};

    await this.step("session", async () => {
      purged.sessions = await this.deleteInBatches("session", (limit) =>
        this.prisma.session.deleteMany({
          where: { expiresAt: { lt: now } },
          limit,
        }),
      );
    });

    await this.step("verification", async () => {
      purged.verifications = await this.deleteInBatches(
        "verification",
        (limit) =>
          this.prisma.verification.deleteMany({
            where: { expiresAt: { lt: now } },
            limit,
          }),
      );
    });

    await this.step("anonymized account", async () => {
      purged.anonymizedAccounts = await this.deleteInBatches(
        "anonymized account",
        (limit) =>
          this.prisma.user.deleteMany({
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

    await this.step("deletion request", async () => {
      const deletionCutoff = new Date(
        now.getTime() - this.deletionRequestRetentionDays * 86_400_000,
      );
      purged.deletionRequests = await this.deleteInBatches(
        "deletion request",
        (limit) =>
          this.prisma.dataDeletionRequest.deleteMany({
            where: { createdAt: { lt: deletionCutoff } },
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

  private async deleteInBatches(
    label: string,
    run: (take: number) => Promise<{ count: number }>,
  ): Promise<number> {
    let total: number = 0;

    for (;;) {
      const { count } = await run(PURGE_BATCH_SIZE);
      total += count;

      if (count < PURGE_BATCH_SIZE) {
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
  async collectOrphanGhostListings() {
    const orphans = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT rl."id"
      FROM "replacement_listing" rl
      WHERE rl."createdById" = ${GHOST_PROFILE_ID}
        AND NOT EXISTS (
          SELECT 1 FROM "application" a WHERE a."listingId" = rl."id"
        )`;

    if (orphans.length === 0) {
      return 0;
    }

    await this.prisma.replacementListing.deleteMany({
      where: { id: { in: orphans.map((orphan) => orphan.id) } },
    });

    logEvent("data_lifecycle.ghost_listings_collected", {
      collected: orphans.length,
    });

    return orphans.length;
  }

  /**
   * Runs `work` under a session-level advisory lock, or returns immediately when
   * another replica holds it.
   *
   * Every replica runs the same crons, so with two of them an hourly sweep ran
   * twice and the second one waited on the first one's locks for no reason.
   */
  private async withAdvisoryLock(
    lockId: number,
    work: () => Promise<void>,
  ): Promise<void> {
    const [locked] = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockId}) AS locked`;

    if (!locked?.locked) {
      logEvent("data_lifecycle.sweep_skipped", { lockId });
      return;
    }

    try {
      await work();
    } finally {
      await this.prisma.$executeRaw`SELECT pg_advisory_unlock(${lockId})`;
    }
  }
}
