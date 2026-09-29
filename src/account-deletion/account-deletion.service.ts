import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ALL_PLATFORM_REJECTION_REASONS,
  AUTO_REJECTION_PLATFORM_REASONS,
  REASON_CANDIDATE_UNAVAILABLE,
} from "../applications/rejection-reasons";
import { detachThirdPartyApplications } from "../common/ghost-listing";
import { recalcListingStatus } from "../common/listing-status";
import { getOwnedProfileIdSafe } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import type { Prisma } from "../generated/prisma/client";
import { anonymizedEmailFor, deletionHash } from "../lib/hash";
import { logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** Prefix of the single-use deletion token rows in the `verification` table. */
const DELETE_ACCOUNT_IDENTIFIER_PREFIX = "delete-account-";

/** Prefix better-auth gives password-reset rows in the same table. */
const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

const ANONYMIZED_LISTING_TITLE = "Offre retirée";
const ANONYMIZED_PRACTICE_FIELD = "—";

/**
 * Every reason `accept` may have written when it auto-rejected the other
 * candidates of a listing. Anonymizing that accepted candidate invalidates
 * those reasons, so the rows have to be identified to go back into the
 * pipeline.
 *
 * Matching on the literal is the only handle available: `reject` takes a free
 * text reason, so nothing in the schema distinguishes an auto-rejection from a
 * manual one. A practice that typed one of these exact sentences by hand would
 * have its candidate restored — an acceptable price for not adding a column to
 * every application row to serve a case that is itself rare.
 *
 * Sourced from `rejection-reasons.ts` rather than spelled out here. This list
 * and `ALL_PLATFORM_REJECTION_REASONS` answer the same question from opposite
 * sides — is this string ours? — so two literals would drift the moment a
 * reason is reworded, and one side would quietly stop matching.
 *
 * The English spelling is included because rows written before the reasons were
 * translated still carry it; without it an erasure would leave those candidates
 * rejected on a premise that no longer holds.
 */
const AUTO_REJECTION_REASONS: string[] = [...AUTO_REJECTION_PLATFORM_REASONS];

/**
 * Machine-readable discriminators for the failures this endpoint can return.
 *
 * Every one of these rides on a status code shared with an unrelated failure
 * — 409 covers both the listings blocker and a missing audit row, 410 covers
 * both an expired link and an account that is already gone — and a client
 * that cannot tell them apart shows the wrong screen and offers advice that
 * cannot work. Mirrored by the frontend's `DeletionFailure` union.
 */
export const ERASURE_ERROR_CODES = {
  /** 409: other candidates hold applications the cascade would destroy. */
  THIRD_PARTY_APPLICATIONS: "THIRD_PARTY_APPLICATIONS",
  /** 409: no PENDING trail row matches this confirmation. */
  NO_PENDING_REQUEST: "NO_PENDING_REQUEST",
  /** 410: the 24h single-use token is past its expiry. */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** 410: the account was already anonymized by an earlier confirmation. */
  ALREADY_ERASED: "ALREADY_ERASED",
} as const;

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

  /**
   * The key backing every fingerprint this service writes.
   *
   * Resolved per call and validated, rather than cached in the constructor: a
   * missing key must fail loudly here instead of degrading into an empty
   * pepper. `createHmac` accepts one without complaint and returns a
   * well-formed but unkeyed digest, which is a plain SHA-256 over a
   * lowercased email — reversible with a dictionary, and precisely what
   * `lib/hash` exists to prevent. Failing here also stops the trail rows being
   * written under a key the deployment cannot reproduce.
   */
  private get pepper(): string {
    const pepper = this.config.get<string>("deletionPepper");

    if (!pepper) {
      throw new ServiceUnavailableException(
        "Account erasure is unavailable: DELETION_PEPPER is not configured",
      );
    }

    return pepper;
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
          throw new GoneException({
            code: ERASURE_ERROR_CODES.TOKEN_EXPIRED,
            message:
              "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
          });
        }

        const consumed = await tx.verification.deleteMany({
          where: { identifier, expiresAt: { gt: now } },
        });

        if (consumed.count === 0) {
          throw new GoneException({
            code: ERASURE_ERROR_CODES.TOKEN_EXPIRED,
            message:
              "Ce lien de confirmation a expiré (valable 24 heures). Relancez la demande depuis votre profil.",
          });
        }

        const userId = token.value;
        const user = await tx.user.findUnique({ where: { id: userId } });

        if (!user || user.deletedAt) {
          // Distinct from an expired link: the erasure already happened, and
          // the right advice is "nothing left to do", not "try again".
          throw new GoneException({
            code: ERASURE_ERROR_CODES.ALREADY_ERASED,
            message: "Ce compte a déjà été supprimé.",
          });
        }

        const profileId = await getOwnedProfileIdSafe(tx, userId);

        // No `assertNoThirdPartyApplications` here, unlike the three endpoints
        // that delete a listing, a practice or a profile directly.
        //
        // Those run the deletion immediately, so a third-party application on
        // the row would be cascaded away with nothing to preserve it: the
        // guard is the only thing standing between them and that. An erasure
        // is different — `anonymize` runs inside the same transaction and
        // detaches those applications onto ghost listings first, so the
        // cascade no longer reaches them.
        //
        // Guarding here instead made the detachment unreachable: it lives
        // after this point, so it could only ever run when there was nothing to
        // preserve. A practice with a filled listing, which by definition
        // carries an ACCEPTED row, could not erase their account at all, and
        // the 409 told them to close their listings — which cannot un-fill
        // one. An article 17 request has to be answerable, and it is: the
        // erasure goes through and the candidate keeps their application, its
        // status, the practice's decision and the timestamps.
        //
        // The audit trail below is what makes this accountable rather than
        // silent: if the trail cannot be updated the whole transaction rolls
        // back, so the erasure is never carried out unrecorded.

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
          // Shares 409 with the listings blocker, and means something entirely
          // different: nothing is holding the account, no listing needs
          // closing, and retrying will not help. The code lets the client say so.
          throw new ConflictException({
            code: ERASURE_ERROR_CODES.NO_PENDING_REQUEST,
            message:
              "No pending erasure request matches this confirmation. Please request the deletion again.",
          });
        }

        await this.anonymize(tx, {
          userId,
          email: user.email,
          profileId,
          now,
        });
        await this.revokeAccess(tx, userId);
        await this.purgeVerificationRows(tx, userId);

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

    // The practice's own words about the candidates who applied. Runs BEFORE
    // the detachment below, and that ordering is load-bearing: the scrub is
    // scoped to `listing: listingFilter`, so detaching first would move the
    // rows onto ghost listings and put them permanently out of reach — a
    // candidate then kept a practice's free-text rejection reason on a row the
    // erasure had preserved.
    //
    // Only the practice's prose goes. A reason this platform wrote describes a
    // transition of the listing rather than a judgement about a person, and
    // clearing it would leave the candidate with a bare « Rejetée » and no way
    // to tell a decision that was never taken from one that was.
    await tx.application.updateMany({
      where: {
        listing: listingFilter,
        applicantId: { not: profileId },
        rejectionReason: { notIn: ALL_PLATFORM_REJECTION_REASONS },
      },
      data: { rejectionReason: null },
    });

    // Before anything below overwrites the listings. The applications pointing
    // at them belong to other candidates, and the cascade that removes this
    // account would take them with it; the ghosts have to be created while those
    // listings are still the ones the rows reference. It also settles the rows
    // it moves, after the scrub above, so `REASON_LISTING_ERASED` survives it.
    await detachThirdPartyApplications(tx, profileId, listingFilter, now);

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
      data: {
        title: ANONYMIZED_LISTING_TITLE,
        description: null,
        // Out of circulation. `findAll` pins `status: "OPEN"` and filters no
        // other way, and `create` only refuses applications to anything but
        // OPEN / IN_DISCUSSION, so a listing left OPEN would keep appearing in
        // the public search and keep accepting candidates for the whole grace
        // period — applications the purge would then cascade away, with no
        // warning to the practice or to the new candidate.
        //
        // CANCELLED rather than CLOSED: nobody closed this listing, it stopped
        // existing with its owner. Both are terminal, so `recalcListingStatus`
        // will not reopen them.
        status: "CANCELLED",
      },
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

    // Free text the person wrote, in both directions.
    //
    // `rejectionReason` on the applications they SENT was written by a
    // practice about them, not by them, and the practice could still read it
    // through `findMine` for the whole grace period. The anonymization has to
    // cover it here: the later scrub below only handles the opposite direction.
    await tx.application.updateMany({
      where: { applicantId: profileId },
      data: {
        message: null,
        withdrawnReason: null,
        rejectionReason: null,
      },
    });

    for (const { listingId } of listingsToRecalculate) {
      await recalcListingStatus(tx, listingId);
    }

    await this.releaseAcceptedPlacements(tx, profileId, now);
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
          rejectionReason: REASON_CANDIDATE_UNAVAILABLE,
          respondedAt: now,
        },
      });

      await tx.application.updateMany({
        where: {
          listingId: application.listingId,
          id: { not: application.id },
          status: "REJECTED",
          rejectionReason: { in: AUTO_REJECTION_REASONS },
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
   * Clears the single-use links the account still holds.
   *
   * `verification` has no foreign key to `user`, so those rows survive the
   * account on their own. Two identifiers exist in this deployment, and both
   * are matched by prefix on the user id kept in `value`:
   * `delete-account-<token>` (written by better-auth on the erasure request)
   * and `reset-password:<token>`. Nothing writes a raw email into `identifier`
   * — email verification and address change use a signed JWT instead — so
   * there is no email-keyed row to clear here, and none to look for.
   *
   * An outstanding password reset is worth removing rather than waiting out:
   * the credential it would restore is already gone, so the link can only fail.
   */
  private async purgeVerificationRows(
    tx: Transaction,
    userId: string,
  ): Promise<void> {
    await tx.verification.deleteMany({
      where: {
        value: userId,
        OR: [
          { identifier: { startsWith: DELETE_ACCOUNT_IDENTIFIER_PREFIX } },
          { identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
        ],
      },
    });
  }
}
