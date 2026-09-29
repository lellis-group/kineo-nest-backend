import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { assertNoThirdPartyApplications } from "../common/application-guard";
import { recalcListingStatus } from "../common/listing-status";
import { getOwnedProfileIdSafe } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import type { Prisma } from "../generated/prisma/client";
import { anonymizedEmailFor, deletionHash } from "../lib/hash";
import { logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** Prefix of the single-use deletion token rows in the `verification` table. */
const DELETE_ACCOUNT_IDENTIFIER_PREFIX = "delete-account-";

const ANONYMIZED_LISTING_TITLE = "Offre retirée";
const ANONYMIZED_PRACTICE_FIELD = "—";

const THIRD_PARTY_APPLICATIONS_MESSAGE =
  "Your listings still have active applications from other candidates. Close or cancel them before deleting your account.";

/**
 * Reason written on the applications `accept` auto-rejected when it filled a
 * listing. Anonymizing that accepted candidate invalidates the reason, so the
 * rows have to be identified to put them back in the pipeline.
 *
 * Matching on the literal is the only handle available: `reject` takes a free
 * text reason, so nothing in the schema distinguishes an auto-rejection from a
 * manual one. A practice that typed this exact sentence by hand would see its
 * candidate restored — an acceptable price for not adding a column to every
 * application row to serve a case that is itself rare.
 */
const AUTO_REJECTION_REASON = "Another candidate was selected for this listing";

/** Reason shown to the applicants left without a replacement. */
const REPLACEMENT_UNAVAILABLE_REASON =
  "The selected candidate is no longer available for this listing";

/** Reason recorded on the accepted application that can no longer be honoured. */
const ACCEPTED_ERASED_REASON = "This candidate is no longer available";

type Transaction = Prisma.TransactionClient;

/**
 * Executes an account erasure request (art. 17 GDPR) without requiring a
 * session: the emailed single-use token is the proof of identity, which keeps
 * the flow usable from another browser or after the session expired.
 *
 * art. 17(1) demands erasure without undue delay, and art. 17(3) still leaves
 * room for legal claims, so the two steps are separated:
 *
 * 1. the request phase (better-auth) emails a 24h token and opens a
 *    `DataDeletionRequest` trail;
 * 2. this confirmation, in one serializable transaction, consumes the token
 *    atomically, refuses the deletion when it would destroy another
 *    candidate's application, anonymizes every personal field and revokes
 *    access;
 * 3. a scheduled sweep drops the anonymized rows once the grace period lapses,
 *    and the `User -> Profile -> Practice -> ReplacementListing ->
 *    Application` cascade takes the business data with it.
 *
 * Anonymizing rather than deleting outright is what keeps step 3 recoverable
 * during the grace period (legal hold, support request) while leaving nothing
 * personal in the database and nothing usable by the account holder.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private get pepper(): string {
    return this.config.get<string>("deletionPepper", "") ?? "";
  }

  async confirmDeletion(token: string): Promise<void> {
    const identifier = `${DELETE_ACCOUNT_IDENTIFIER_PREFIX}${token.trim()}`;
    const now = new Date();

    const anonymizedUserId = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        // The token is resolved and then consumed by a conditional delete whose
        // predicate is the expiry. Under the serializable isolation below, two
        // concurrent confirmations of the same link (double click, two open
        // tabs) cannot both commit: the loser aborts, retries, and by then
        // finds no token at all. A plain read-then-write would instead let both
        // pass the check and the loser would surface as a P2025 on the
        // anonymization, i.e. a 500 on a request the user made correctly.
        const token = await tx.verification.findFirst({
          where: { identifier },
        });

        if (!token) {
          throw new NotFoundException(
            "Ce lien de confirmation est invalide ou a déjà été utilisé.",
          );
        }

        if (token.expiresAt.getTime() < now.getTime()) {
          throw new GoneException(
            "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
          );
        }

        const consumed = await tx.verification.deleteMany({
          where: { identifier, expiresAt: { gt: now } },
        });

        if (consumed.count === 0) {
          throw new GoneException(
            "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
          );
        }

        const userId = token.value;
        const user = await tx.user.findUnique({ where: { id: userId } });

        if (!user || user.deletedAt) {
          throw new GoneException("Ce compte a déjà été supprimé.");
        }

        const profileId = await getOwnedProfileIdSafe(tx, userId);

        if (profileId) {
          await assertNoThirdPartyApplications(
            tx,
            profileId,
            {
              OR: [
                { createdById: profileId },
                { practice: { ownerId: profileId } },
              ],
            },
            THIRD_PARTY_APPLICATIONS_MESSAGE,
          );
        }

        // The trail must move to ANONYMIZED in the same transaction as the
        // anonymization itself. If it cannot, the account would be erased with
        // no provable record of it, so the transaction rolls back instead.
        const audited = await tx.dataDeletionRequest.updateMany({
          where: {
            userIdHash: deletionHash(userId, this.pepper),
            status: "PENDING",
          },
          data: { status: "ANONYMIZED", executedAt: now },
        });

        if (audited.count === 0) {
          throw new ConflictException(
            "No pending erasure request matches this confirmation. Please request the deletion again.",
          );
        }

        await this.anonymize(tx, {
          userId,
          email: user.email,
          profileId,
          now,
        });
        await this.revokeAccess(tx, userId);
        await this.purgeVerificationRows(tx, userId, user.email);

        return userId;
      },
    );

    logEvent("account.deletion.anonymized", {
      userIdHash: deletionHash(anonymizedUserId, this.pepper),
    });
  }

  /**
   * Overwrites every field that identifies a person, in both directions: what
   * the account holder published, and what other people wrote about them.
   */
  private async anonymize(
    tx: Transaction,
    context: {
      userId: string;
      email: string;
      profileId: string | undefined;
      now: Date;
    },
  ): Promise<void> {
    const { userId, profileId, now } = context;

    await tx.user.update({
      where: { id: userId },
      data: {
        email: anonymizedEmailFor(userId, this.pepper),
        name: null,
        image: null,
        emailVerified: false,
        deletedAt: now,
      },
    });

    if (!profileId) {
      return;
    }

    const listingFilter: Prisma.ReplacementListingWhereInput = {
      OR: [{ createdById: profileId }, { practice: { ownerId: profileId } }],
    };

    await tx.profile.update({
      where: { id: profileId },
      data: {
        rppsNumber: null,
        city: null,
        latitude: null,
        longitude: null,
        isPublic: false,
        verified: false,
      },
    });

    await tx.practice.updateMany({
      where: { ownerId: profileId },
      data: {
        name: ANONYMIZED_PRACTICE_FIELD,
        address: ANONYMIZED_PRACTICE_FIELD,
        city: ANONYMIZED_PRACTICE_FIELD,
        latitude: null,
        longitude: null,
        isPublic: false,
      },
    });

    await tx.replacementListing.updateMany({
      where: listingFilter,
      data: { title: ANONYMIZED_LISTING_TITLE, description: null },
    });

    // Applications the person sent. The free text is their own personal data
    // and stays readable by the receiving practice otherwise. Active ones also
    // leave the pipeline, so no colleague keeps a pending or shortlisted
    // candidate they can no longer reach.
    //
    // The listings are collected first: the status of a listing is derived
    // from the applications it holds, so freeing capacity without recomputing
    // would leave an owner advertising a `FULL` slot they no longer need, and
    // `findAll` would keep hiding their listing.
    const listingsToRecalculate = await tx.application.findMany({
      where: {
        applicantId: profileId,
        status: { in: ["PENDING", "SHORTLISTED"] },
      },
      select: { listingId: true },
      distinct: ["listingId"],
    });

    await tx.application.updateMany({
      where: {
        applicantId: profileId,
        status: { in: ["PENDING", "SHORTLISTED"] },
      },
      data: { status: "WITHDRAWN", respondedAt: now },
    });

    await tx.application.updateMany({
      where: { applicantId: profileId },
      data: { message: null, withdrawnReason: null },
    });

    for (const { listingId } of listingsToRecalculate) {
      await recalcListingStatus(tx, listingId);
    }

    await this.releaseAcceptedPlacements(tx, profileId, now);

    // Applications the person received. The rejection reason is written by the
    // account holder and read by the applicant; the status is kept so the
    // applicant still sees a coherent history.
    await tx.application.updateMany({
      where: { listing: listingFilter, applicantId: { not: profileId } },
      data: { rejectionReason: null },
    });
  }

  /**
   * Frees the listings this person had been accepted on.
   *
   * `accept` fills a listing, rejects every other candidate with
   * `AUTO_REJECTION_REASON`, and from then on the owner has no reason to look
   * at that listing again. If the accepted candidate then erases their
   * account, the practice is left with a `FILLED` listing, nobody in the post,
   * and a pool it had already turned down on a premise that no longer holds.
   *
   * The listing is therefore reopened and the auto-rejected candidates put
   * back in the pipeline, so the owner finds the same pool it started with and
   * can pick again. Their own free-text rejections are left alone: those were
   * a considered decision, not a side effect of the selection.
   */
  private async releaseAcceptedPlacements(
    tx: Transaction,
    profileId: string,
    now: Date,
  ): Promise<void> {
    const accepted = await tx.application.findMany({
      where: { applicantId: profileId, status: "ACCEPTED" },
      select: { id: true, listingId: true },
    });

    for (const application of accepted) {
      await tx.application.update({
        where: { id: application.id },
        data: {
          status: "REJECTED",
          rejectionReason: ACCEPTED_ERASED_REASON,
          respondedAt: now,
        },
      });

      await tx.application.updateMany({
        where: {
          listingId: application.listingId,
          id: { not: application.id },
          status: "REJECTED",
          rejectionReason: AUTO_REJECTION_REASON,
        },
        data: { status: "PENDING", rejectionReason: null, respondedAt: null },
      });

      await recalcListingStatus(tx, application.listingId, {
        includeFilled: true,
      });
    }
  }

  /** Cuts every way back in: session cookies, password hash, OAuth tokens. */
  private async revokeAccess(tx: Transaction, userId: string): Promise<void> {
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
  }

  /**
   * `verification` has no foreign key to `user`, so the rows keyed by the
   * account (email verification, password reset, leftover deletion links) are
   * cleared explicitly. The hourly expiry sweep is the safety net.
   */
  private async purgeVerificationRows(
    tx: Transaction,
    userId: string,
    email: string,
  ): Promise<void> {
    await tx.verification.deleteMany({
      where: {
        OR: [
          { identifier: email },
          {
            identifier: { startsWith: DELETE_ACCOUNT_IDENTIFIER_PREFIX },
            value: userId,
          },
        ],
      },
    });
  }
}
