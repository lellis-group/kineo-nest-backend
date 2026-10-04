import { GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { deletionHash, deletionPepper } from "../lib/hash";
import { logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";
import { anonymizeAccount, type ErasureOutcome } from "./anonymize";
import { deleteAccountIdentifier } from "./deletion-token";

export interface ErasureResult extends ErasureOutcome {
  anonymizedAt: string;
}

/**
 * Art. 17 erasure, without the session.
 *
 * better-auth's own `POST /delete-user { token }` requires a valid session cookie
 * at click time: a different browser, an expired session or blocked cookies all
 * answer "invalid link" while the token is valid. Here the emailed link is the
 * proof of identity, so the confirmation works from any device.
 *
 * The account is anonymized rather than deleted. A cascade would take the
 * applications other candidates wrote on this person's listings, and that data is
 * not ours to erase on their behalf; `deletedAt` marks the row and the purge
 * sweep drops it once the grace period has passed.
 */
@Injectable()
export class AccountDeletionService {
  constructor(private readonly prisma: PrismaService) {}

  async confirmDeletion(token: string): Promise<ErasureResult> {
    const trimmed = token.trim();

    // Refused before anything is read: without a pepper the trail cannot be
    // keyed, and an erasure that goes through anyway would leave the
    // accountability record in a state nobody can search.
    const pepper = deletionPepper();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const verification = await tx.verification.findFirst({
          where: { identifier: deleteAccountIdentifier(trimmed) },
        });

        if (!verification) {
          throw new NotFoundException(
            "Ce lien de confirmation est invalide ou a déjà été utilisé.",
          );
        }

        if (verification.expiresAt.getTime() < Date.now()) {
          await tx.verification.delete({ where: { id: verification.id } });
          throw new GoneException(
            "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
          );
        }

        const userId = verification.value;
        const user = await tx.user.findUnique({ where: { id: userId } });

        if (!user) {
          await tx.verification.delete({ where: { id: verification.id } });
          throw new GoneException("Ce compte a déjà été supprimé.");
        }

        if (user.deletedAt) {
          await tx.verification.delete({ where: { id: verification.id } });
          throw new GoneException("Ce compte a déjà été supprimé.");
        }

        const userIdHash = deletionHash(user.id, pepper);

        const erasure = await anonymizeAccount(tx, {
          userId,
          email: user.email,
          userIdHash,
        });

        await tx.dataDeletionRequest.updateMany({
          where: { userIdHash, status: "PENDING" },
          data: { status: "EXECUTED", executedAt: new Date() },
        });

        return { ...erasure, anonymizedAt: new Date().toISOString() };
      },
      { isolationLevel: "Serializable", timeout: 10_000 },
    );

    logEvent("account.deletion.anonymized", {
      anonymizedListings: outcome.anonymizedListings,
      settledApplications: outcome.settledApplications,
      protectedPlacements: outcome.protectedPlacements,
    });

    return outcome;
  }
}
