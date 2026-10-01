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
      const now = new Date();

      const sessions = await this.prisma.session.deleteMany({
        where: { expiresAt: { lt: now } },
      });

      const verifications = await this.prisma.verification.deleteMany({
        where: { expiresAt: { lt: now } },
      });

      // A request that was never confirmed is only a trace of an intention.
      // Its 24h token died long ago, so it keeps no value after a month.
      const abandonedRequests =
        await this.prisma.dataDeletionRequest.deleteMany({
          where: {
            status: { in: ["PENDING", "SUPERSEDED"] },
            updatedAt: {
              lt: daysAgo(now, this.pendingDeletionRequestRetentionDays),
            },
          },
        });

      const executedRequests = await this.prisma.dataDeletionRequest.deleteMany(
        {
          where: {
            status: "ANONYMIZED",
            updatedAt: {
              lt: daysAgo(now, this.deletionRequestRetentionDays),
            },
          },
        },
      );

      if (
        sessions.count > 0 ||
        verifications.count > 0 ||
        abandonedRequests.count > 0 ||
        executedRequests.count > 0
      ) {
        logEvent("data_lifecycle.sweep", {
          sessionsPurged: sessions.count,
          verificationsPurged: verifications.count,
          abandonedRequestsPurged: abandonedRequests.count,
          executedRequestsPurged: executedRequests.count,
          retentionDays: this.deletionRequestRetentionDays,
        });
      }
    } catch (error) {
      // Never break the process over a sweep: it will run again on schedule.
      logError("data_lifecycle.sweep_failed", error);
    }
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
    try {
      const graceDays = this.accountPurgeGraceDays;
      const purged = await this.prisma.user.deleteMany({
        where: { deletedAt: { lt: daysAgo(new Date(), graceDays) } },
      });

      // Run after the cascade above, and never before: a ghost only becomes
      // collectable once the application it carried has actually gone.
      const ghosts = await this.purgeOrphanGhostListings();

      if (purged.count > 0 || ghosts > 0) {
        logEvent("data_lifecycle.accounts_purged", {
          accountsPurged: purged.count,
          orphanGhostListingsPurged: ghosts,
          graceDays,
        });
      }
    } catch (error) {
      logError("data_lifecycle.accounts_purge_failed", error);
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
