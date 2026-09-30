import { REASON_LISTING_ERASED } from "../applications/rejection-reasons";
import type { Prisma } from "../generated/prisma/client";
import { GHOST_LISTING_TITLE, SYSTEM_SCAFFOLD } from "./system-scaffold";

/**
 * Moves the applications other people filed on this account's listings onto
 * ghost listings, so the erasure cascade stops short of them.
 *
 * The cascade is `User -> Profile -> Practice -> ReplacementListing ->
 * Application`, so an application sitting on the erased account's listing is
 * destroyed with it — and that row is someone else's: their message, and the
 * practice's decision about them. Nobody asked them.
 *
 * This is what lets `confirmDeletion` drop its guard. The three endpoints that
 * delete a listing, a practice or a profile in one shot keep theirs, because
 * they have no equivalent step; this one runs in the same transaction, ahead of
 * the anonymization, so the erasure still succeeds and the candidate's row
 * survives it.
 *
 * One ghost listing PER ORIGINAL LISTING, deliberately. A single ghost for the
 * whole account would put three applications from the same candidate — one per
 * listing they had applied to — on the same `(listingId, applicantId)` pair,
 * which is a unique index. Copying the listings 1:1 keeps those pairs intact
 * and lets the candidate still recognise which posting they applied to.
 *
 * Must run BEFORE the listings are anonymized. Once their title, dates and
 * practice name are overwritten there is nothing left to copy, and by then the
 * listing is no longer the one the applications point at.
 *
 * The applications are also settled here, as `close` and `cancel` settle them
 * when an owner takes a posting out of circulation. Preserving the row is not
 * enough — preserving a state nobody will ever move on from is a lie the
 * candidate reads on their own dashboard. Everything but `WITHDRAWN` becomes
 * `REJECTED` with `REASON_LISTING_ERASED`, including rows the practice had
 * already rejected, because the account's scrub takes their free text with it
 * and the status has to still be explicable afterwards.
 *
 * The ghosts are `CLOSED`, so they are absent from the public search (`findAll`
 * filters on `OPEN`) and `recalcListingStatus` will not touch them. They belong
 * to the system profile, so the purge sweep never collects them: they live as
 * long as the applications they carry, which is what should happen — while a
 * candidate's application exists, its context must exist too.
 */
export async function detachThirdPartyApplications(
  tx: Prisma.TransactionClient,
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput,
  now: Date,
): Promise<number> {
  const listings = await tx.replacementListing.findMany({
    where: listingFilter,
    select: { id: true },
  });

  let detached = 0;

  for (const listing of listings) {
    // Every third-party row, whatever its status. A `REJECTED` application is
    // not ownerless data: it holds the message the candidate wrote and the
    // reason the practice gave, and neither of them is ours to erase on
    // someone else's request. Filtering on `PENDING`/`SHORTLISTED`/`ACCEPTED`
    // would have left the settled rows to be cascaded away silently.
    const candidates = await tx.application.findMany({
      where: {
        listingId: listing.id,
        applicantId: { not: ownerProfileId },
      },
      select: { id: true, status: true },
    });

    if (candidates.length === 0) {
      continue;
    }

    const ghost = await tx.replacementListing.create({
      data: {
        practiceId: SYSTEM_SCAFFOLD.practiceId,
        createdById: SYSTEM_SCAFFOLD.profileId,
        title: GHOST_LISTING_TITLE,
        // No window: the candidate is not coming back to this posting, and
        // inventing dates would put the practice's schedule in a copy that
        // outlives it.
        startDate: now,
        endDate: now,
        // OTHER, the same sentinel as the system profile: these are not
        // postings anybody can apply to.
        specialty: "OTHER",
        status: "CLOSED",
        urgent: false,
        description: null,
        maxApplications: null,
      },
      select: { id: true },
    });

    // Every third-party row is settled, whichever status it carried.
    //
    // `PENDING`/`SHORTLISTED`/`ACCEPTED` obviously have to be: the decision
    // they were waiting on will never come, and an `ACCEPTED` row would tell a
    // candidate they still have a replacement to turn up for.
    //
    // The already-`REJECTED` ones need it too, and this is not about rewriting
    // a decision. The account's scrub erases the practice's free text — it has
    // to, that text is the practice's own — which would leave the row with a
    // status the candidate cannot account for, and the frontend renders a
    // missing reason as « Aucun motif n'a été communiqué par le cabinet ». That
    // is a false statement: no cabinet ever decided anything. What did happen
    // is that the listing no longer exists, and this says so.
    //
    // `WITHDRAWN` is left alone. The candidate pulled out themselves; the
    // listing being gone afterwards does not change the account of that, and
    // overwriting it would put an erasure they had nothing to do with on top
    // of their own action.
    const settled = candidates
      .filter((candidate) => candidate.status !== "WITHDRAWN")
      .map((candidate) => candidate.id);

    if (settled.length > 0) {
      await tx.application.updateMany({
        where: { id: { in: settled } },
        data: {
          // Same treatment `close` and `cancel` give, and for the same reason:
          // the posting is leaving circulation, so the pending decision will
          // never come.
          status: "REJECTED",
          // Distinct from a practice refusal: nobody chose, the practice is
          // gone. The applicant has to be able to tell the two apart.
          decisionSource: "LISTING_ERASED",
          rejectionReason: REASON_LISTING_ERASED,
          respondedAt: now,
        },
      });
    }

    await tx.application.updateMany({
      where: { id: { in: candidates.map((candidate) => candidate.id) } },
      data: { listingId: ghost.id },
    });

    detached += candidates.length;
  }

  return detached;
}
