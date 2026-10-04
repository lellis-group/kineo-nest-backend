import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { logError } from "../lib/log";
import { PrismaService } from "../prisma.service";
import { SYSTEM_SCAFFOLD } from "./system-scaffold";

/**
 * Guarantees the three system rows the ghost listings hang from exist.
 *
 * `detachThirdPartyApplications` writes `practiceId` and `createdById` pointing
 * at them by id, with no lookup and no fallback. If they are missing the insert
 * raises a foreign-key violation, the erasure rolls back, and the caller gets an
 * opaque 500 — for every account that owns a listing carrying a third-party
 * application, with nothing in the logs naming the missing row.
 *
 * They exist because the `system_scaffold` migration inserted them once, and
 * that migration is `ON CONFLICT DO NOTHING`, so it never runs again on a
 * database that already has them. It also means a restore that excluded those
 * rows, or a deployment that went through `db:push` rather than `migrate
 * deploy`, never had them at all. Recreating is idempotent and costs three
 * upserts at boot.
 *
 * Not fatal. Failing boot would take the whole API down — reads, writes, health
 * — over three rows that only the erasure path needs, and the erasure is better
 * refused loudly than served by a half-built scaffold. What matters is that the
 * erasure stops failing mysteriously.
 */
@Injectable()
export class SystemScaffoldService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemScaffoldService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensure();
    } catch (error) {
      this.logger.error(
        "The system scaffold is unavailable; account erasure will be refused",
      );
      logError("system_scaffold.ensure_failed", error);
    }
  }

  async ensure(): Promise<void> {
    const now = new Date();

    await this.prisma.user.upsert({
      where: { id: SYSTEM_SCAFFOLD.userId },
      create: {
        id: SYSTEM_SCAFFOLD.userId,
        // Not a deliverable address: RFC 2606 reserves `.invalid`, so nothing
        // can be sent to it or registered by a third party.
        email: "system@deleted.invalid",
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });

    await this.prisma.profile.upsert({
      where: { id: SYSTEM_SCAFFOLD.profileId },
      create: {
        id: SYSTEM_SCAFFOLD.profileId,
        userId: SYSTEM_SCAFFOLD.userId,
        specialty: "OTHER",
        profileType: "INSTALLED",
        // `isPublic` defaults to true, so it is set explicitly: a public
        // directory entry for a system row would be a bug.
        isPublic: false,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });

    await this.prisma.practice.upsert({
      where: { id: SYSTEM_SCAFFOLD.practiceId },
      create: {
        id: SYSTEM_SCAFFOLD.practiceId,
        ownerId: SYSTEM_SCAFFOLD.profileId,
        // Read by candidates under their own application, so a sentence rather
        // than a technical label. `isPublic` false and no coordinates keep it
        // out of `GET /practices` and out of geo search.
        name: "Annonce retirée par son auteur",
        address: "—",
        city: "—",
        isPublic: false,
        createdAt: now,
      },
      update: {},
    });
  }
}
