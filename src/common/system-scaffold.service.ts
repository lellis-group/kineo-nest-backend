import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ProfileType, Specialty } from "../generated/prisma/enums";
import { logError, logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";
import { SYSTEM_SCAFFOLD } from "./system-scaffold";

/**
 * Puts the system scaffold back if it is missing.
 *
 * The three rows third-party applications are parked on used to be created by
 * `bun run db:seed` and by nothing else, so a deployment that ran `migrate deploy`
 * and stopped had none — and every erasure of an account whose listing carried
 * somebody else's application failed, with a 503 and nothing in the logs naming the
 * row that was missing. A migration creates them now; this covers what a migration
 * cannot: a database restored from a dump taken before it, or one where the rows
 * were deleted by hand.
 *
 * `createMany` with `skipDuplicates` rather than three upserts, because it reports
 * how many rows it actually inserted. Zero means the scaffold was already there
 * and nothing happened, which is the case on every boot of a healthy deployment —
 * and saying so is the difference between a useful warning and a permanent one.
 *
 * Deliberately not fatal. A boot that failed here would take down an API that can
 * still answer every route not involving an erasure, in exchange for a problem that
 * is already reported loudly when it is reached. So it logs, and the erasure path
 * keeps refusing with the error that names the cause.
 */
@Injectable()
export class SystemScaffoldService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemScaffoldService.name);

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const created = await this.ensure();
      if (created > 0) {
        this.logger.warn(
          `The system scaffold was missing and has been recreated (${created} row(s))`,
        );
        logEvent("system_scaffold.restored", { rows: created });
      }
    } catch (error) {
      this.logger.error(
        "The system scaffold is unavailable; account erasure will be refused",
      );
      logError("system_scaffold.ensure_failed", error);
    }
  }

  /** How many rows had to be created. Zero means it was already there. */
  private async ensure(): Promise<number> {
    const now = new Date();

    const user = await this.prisma.user.createMany({
      data: [
        {
          id: SYSTEM_SCAFFOLD.userId,
          email: SYSTEM_SCAFFOLD.email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });

    const profile = await this.prisma.profile.createMany({
      data: [
        {
          id: SYSTEM_SCAFFOLD.profileId,
          userId: SYSTEM_SCAFFOLD.userId,
          specialty: Specialty.GENERALIST,
          profileType: ProfileType.INSTALLED,
          verified: true,
          isPublic: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });

    const practice = await this.prisma.practice.createMany({
      data: [
        {
          id: SYSTEM_SCAFFOLD.practiceId,
          ownerId: SYSTEM_SCAFFOLD.profileId,
          name: "System (withdrawn listings)",
          address: "-",
          city: "-",
          isPublic: false,
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });

    return user.count + profile.count + practice.count;
  }
}
