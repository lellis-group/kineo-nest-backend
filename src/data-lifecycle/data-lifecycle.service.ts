import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SYSTEM_SCAFFOLD } from "../common/system-scaffold";
import { logError, logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** Default retention horizon for the accountability trail (days). */
export const DELETION_REQUEST_RETENTION_DAYS = 365;

/** Default horizon for a request that was never confirmed (days). */
export const PENDING_DELETION_REQUEST_RETENTION_DAYS = 30;

/** Default delay between anonymization and the physical purge (days). */
export const ACCOUNT_PURGE_GRACE_DAYS = 30;

const DAY_IN_MS = 86_400_000;

/**
 * Rows deleted per statement by the sweeps.
 *
 * `deleteMany` takes no `take`, so an unbounded sweep is one transaction that
 * grows with the backlog: a long outage or a large backdated `deletedAt` set
 * turns it into a very long transaction holding locks, in the process that is
 * serving requests. Batching keeps each one short and lets the loop stop on a
 * quiet table.
 */
const SWEEP_BATCH_SIZE = 1_000;

/** Guard against a sweep that never converges on a table it cannot drain. */
const MAX_SWEEP_BATCHES = 1_000;

/**
 * Advisory-lock keys, one per schedule.
 *
 * Arbitrary but fixed: the value only has to be stable across replicas of the
 * same deployment and distinct between the two sweeps, since holding both would
 * serialise them against each other for no reason.
 */
const SWEEP_LOCK_KEYS: Record<string, number | undefined> = {
  hourly: 8_147_230_001,
  daily: 8_147_230_002,
};

type SweepTable = "session" | "verification" | "dataDeletionRequest";

function positiveIntegerFromEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Scheduled retention sweeps (data minimization, art. 5(1)(e) GDPR): rows that
 * carry PII and are no longer useful must not outlive their expiry.
 *
 * - `session`: expired rows keep the session token, IP and user agent forever.
 * - `verification`: better-auth only deletes expired rows lazily, when a given
 *   identifier is read; unread rows (abandoned sign-up, one-time delete links)
 *   would stay forever. Rows hold a pseudonymous user id in `value` and a
 *   prefixed token in `identifier` (`delete-account-*`, `reset-password:*`),
 *   not a raw email: address verification uses a signed JWT.
 * - `dataDeletionRequest`: the accountability trail holds fingerprints, not
 *   plain identifiers, but a justified retention is not a forever one. It is
 *   bounded by two horizons, both anchored on `updatedAt` rather than
 *   `createdAt`: a request created long ago and confirmed today must serve its
 *   full retention from the moment it was executed, otherwise the proof of
 *   erasure would be swept within the hour.
 * - anonymized `user` rows: dropped once the grace period lapses, which is
 *   what actually clears the business data through the cascade.
 */
@Injectable()
export class DataLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(ConfigService)
    private readonly config?: ConfigService,
  ) {}

  private numberFrom(
    configKey: string,
    envName: string,
    fallback: number,
  ): number {
    const fromConfig = this.config?.get<number>(configKey);
    if (
      typeof fromConfig === "number" &&
      Number.isSafeInteger(fromConfig) &&
      fromConfig > 0
    ) {
      return fromConfig;
    }
    return positiveIntegerFromEnv(process.env[envName], fallback, envName);
  }

  private get deletionRequestRetentionDays(): number {
    return this.numberFrom(
      "dataDeletionRequestRetentionDays",
      "DATA_DELETION_REQUEST_RETENTION_DAYS",
      DELETION_REQUEST_RETENTION_DAYS,
    );
  }

  private get pendingDeletionRequestRetentionDays(): number {
    return this.numberFrom(
      "pendingDeletionRequestRetentionDays",
      "PENDING_DELETION_REQUEST_RETENTION_DAYS",
      PENDING_DELETION_REQUEST_RETENTION_DAYS,
    );
  }

  private get accountPurgeGraceDays(): number {
    return this.numberFrom(
      "accountPurgeGraceDays",
      "ACCOUNT_PURGE_GRACE_DAYS",
      ACCOUNT_PURGE_GRACE_DAYS,
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired() {
    try {
      if (!(await this.acquireSweepLock("hourly"))) {
        return;
      }

      const now = new Date();
      const pendingDays = this.pendingDeletionRequestRetentionDays;
      const executedDays = this.deletionRequestRetentionDays;

      const sessions = await this.deleteInBatches("session", {
        expiresAt: { lt: now },
      });

      const verifications = await this.deleteInBatches("verification", {
        expiresAt: { lt: now },
      });

      // A request that was never confirmed is only a trace of an intention.
      // Its 24h token died long ago, so it keeps no value after a month.
      const abandonedRequests = await this.deleteInBatches(
        "dataDeletionRequest",
        {
          status: { in: ["PENDING", "SUPERSEDED"] },
          updatedAt: { lt: daysAgo(now, pendingDays) },
        },
      );

      const executedRequests = await this.deleteInBatches(
        "dataDeletionRequest",
        {
          status: "ANONYMIZED",
          updatedAt: { lt: daysAgo(now, executedDays) },
        },
      );

      if (
        sessions > 0 ||
        verifications > 0 ||
        abandonedRequests > 0 ||
        executedRequests > 0
      ) {
        logEvent("data_lifecycle.sweep", {
          sessionsPurged: sessions,
          verificationsPurged: verifications,
          abandonedRequestsPurged: abandonedRequests,
          executedRequestsPurged: executedRequests,
          retentionDays: executedDays,
        });
      }
    } catch (error) {
      // Never break the process over a sweep: it will run again on schedule.
      logError("data_lifecycle.sweep_failed", error);
    }
  }

  /**
   * Deletes everything matching `where`, in batches, and returns the total.
   *
   * `deleteMany` has no `take`, so the alternative is one transaction sized by
   * the whole backlog. `deleteMany` with a `take` is not available, so the batch
   * is a `findMany` of ids followed by a delete scoped to those ids — which is
   * still one statement, and the ids are what the index found.
   */
  private async deleteInBatches(
    table: SweepTable,
    where: Record<string, unknown>,
  ): Promise<number> {
    // The three tables share an id-keyed shape, but their generated delegates
    // are distinct types with no common call signature, so the union cannot be
    // called directly.
    const delegate = this.prisma[table] as unknown as {
      findMany: (args: {
        where: Record<string, unknown>;
        select: { id: true };
        take: number;
      }) => Promise<Array<{ id: string }>>;
      deleteMany: (args: {
        where: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };

    let total = 0;

    for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch += 1) {
      const rows = await delegate.findMany({
        where,
        select: { id: true },
        take: SWEEP_BATCH_SIZE,
      });

      if (rows.length === 0) {
        return total;
      }

      const { count } = await delegate.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });

      total += count;

      if (rows.length < SWEEP_BATCH_SIZE) {
        return total;
      }
    }

    logEvent("data_lifecycle.sweep_truncated", { table, deleted: total });

    return total;
  }

  /**
   * Takes a Postgres advisory lock so only one replica sweeps.
   *
   * `@Cron` fires on every instance, and both sweeps are idempotent — a
   * duplicate run deletes nothing the first did not — so this is about cost
   * rather than correctness: N replicas meant N full scans and N deletes of the
   * same rows, on the same tables, on the same hour. The lock is
   * session-scoped and released when the connection closes, so a replica that
   * dies mid-sweep does not wedge the schedule.
   */
  private async acquireSweepLock(name: string): Promise<boolean> {
    const key = SWEEP_LOCK_KEYS[name];
    if (key === undefined) {
      return true;
    }

    const rows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS locked
    `;

    return rows[0]?.locked === true;
  }

  /**
   * Drops the rows of accounts whose erasure was executed long enough ago.
   *
   * This is the step that makes the erasure irreversible. It runs on its own
   * schedule rather than inside the confirmation transaction so that a large
   * cascade cannot push the interactive request past its timeout, and so the
   * grace period leaves room for an art. 17(3) hold to be lifted or applied.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeAnonymizedAccounts() {
    let purged = 0;

    try {
      if (!(await this.acquireSweepLock("daily"))) {
        return;
      }

      const graceDays = this.accountPurgeGraceDays;

      for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch += 1) {
        const rows = await this.prisma.user.findMany({
          where: { deletedAt: { lt: daysAgo(new Date(), graceDays) } },
          select: { id: true },
          take: SWEEP_BATCH_SIZE,
        });

        if (rows.length === 0) {
          break;
        }

        // One `user` row takes a whole practice, its listings and every
        // application on them, so this stays a bounded number of cascades per
        // statement rather than the whole backlog in one transaction.
        const result = await this.prisma.user.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });

        purged += result.count;

        if (rows.length < SWEEP_BATCH_SIZE) {
          break;
        }
      }
    } catch (error) {
      // Logged, not rethrown, and deliberately separate from the ghost sweep
      // below: an error here used to skip the collection entirely, so one
      // transient lock or foreign-key failure left orphan ghost listings
      // accumulating silently for a day.
      logError("data_lifecycle.accounts_purge_failed", error);
    }

    try {
      // Run after the cascade above, and never before: a ghost only becomes
      // collectable once the application it carried has actually gone. Safe to
      // run on its own after a failure above — it only collects ghosts nothing
      // points at any more.
      const ghosts = await this.purgeOrphanGhostListings();

      if (purged > 0 || ghosts > 0) {
        logEvent("data_lifecycle.accounts_purged", {
          accountsPurged: purged,
          orphanGhostListingsPurged: ghosts,
          graceDays: this.accountPurgeGraceDays,
        });
      }
    } catch (error) {
      logError("data_lifecycle.ghost_purge_failed", error);
    }
  }

  /**
   * Drops the ghost listings no application points at any more.
   *
   * A ghost is created during an erasure to hold the rows other candidates had
   * filed on the account's listings, so the cascade could not destroy them
   * (`ghost-listing.ts`). It exists for exactly as long as those rows do.
   *
   * When the candidate who filed one of those applications erases their own
   * account in turn, their `Profile` cascades and takes the application with
   * it — and the ghost is left behind holding nothing. Nothing else collects
   * it: the ghosts belong to the system profile, which the purge above never
   * reaches because its `deletedAt` stays NULL. So they accumulate silently,
   * one set per erasure that touched a listing another person had applied to.
   *
   * The emptiness test is the whole safety property here. It is a subquery on
   * `application`, not a date comparison: a ghost that still carries a row is
   * the context a candidate reads on their dashboard, and losing it would undo
   * the detachment the erasure performed. A ghost created seconds ago by an
   * erasure still in flight therefore cannot be collected, because its
   * applications exist — which is exactly the condition being checked.
   */
  private async purgeOrphanGhostListings(): Promise<number> {
    const purged = await this.prisma.replacementListing.deleteMany({
      where: {
        practiceId: SYSTEM_SCAFFOLD.practiceId,
        applications: { none: {} },
      },
    });

    return purged.count;
  }
}

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * DAY_IN_MS);
}
