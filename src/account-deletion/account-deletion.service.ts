import { GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** Prefix of the single-use deletion token rows in the `verification` table. */
const DELETE_ACCOUNT_IDENTIFIER_PREFIX = "delete-account-";

function deleteAccountIdentifier(token: string): string {
  return `${DELETE_ACCOUNT_IDENTIFIER_PREFIX}${token}`;
}

/**
 * Totale suppression identique à better-auth `POST /delete-user { token }`
 * MAIS sans exiger de session : le lien email suffit (RGPD art. 17).
 *
 * Exécuté dans une transaction :
 * 1. lecture + consommation atomique du token `delete-account-*` (single-use,
 *    vérification d'expiration incluse) ;
 * 2. suppression du `User` — la cascade Prisma/Postgres (`User → Profile →
 *    Practice → ReplacementListing → Application`, plus `Account`/`Session`)
 *    purge tout le périmètre métier ;
 * 3. purge des lignes `verification` orphelines (pas de FK vers `user`) ;
 * 4. marquage de la demande d'audit `DataDeletionRequest` → EXECUTED.
 */
@Injectable()
export class AccountDeletionService {
  constructor(private readonly prisma: PrismaService) {}

  async confirmDeletion(token: string): Promise<void> {
    const trimmed = token.trim();

    let deletedUserId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      const verification = await tx.verification.findFirst({
        where: { identifier: deleteAccountIdentifier(trimmed) },
      });

      if (!verification) {
        throw new NotFoundException(
          "Ce lien de confirmation est invalide ou a déjà été utilisé.",
        );
      }

      if (verification.expiresAt.getTime() < Date.now()) {
        await tx.verification.delete({
          where: { id: verification.id },
        });
        throw new GoneException(
          "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
        );
      }

      const userId = verification.value;
      const user = await tx.user.findUnique({ where: { id: userId } });

      if (!user) {
        await tx.verification.delete({
          where: { id: verification.id },
        });
        throw new GoneException("Ce compte a déjà été supprimé.");
      }

      const userEmail = user.email;
      deletedUserId = userId;

      await tx.dataDeletionRequest.updateMany({
        where: { userId, status: "PENDING" },
        data: { status: "EXECUTED", executedAt: new Date() },
      });

      await tx.user.delete({ where: { id: userId } });

      // `verification` has no foreign key to `user`: without this purge, the
      // tokens tied to the deleted identity (email verification, password reset,
      // both indexed by email) would outlive the account.
      await tx.verification.deleteMany({
        where: {
          OR: [
            { identifier: userEmail },
            {
              identifier: { startsWith: DELETE_ACCOUNT_IDENTIFIER_PREFIX },
              value: userId,
            },
          ],
        },
      });
    });

    if (deletedUserId) {
      logEvent("account.deletion.confirmed", { userId: deletedUserId });
    }
  }
}
