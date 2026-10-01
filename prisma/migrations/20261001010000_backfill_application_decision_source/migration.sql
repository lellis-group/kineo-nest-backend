-- Data migration: derive `decisionSource` on rows written before the column
-- existed, or produced by a seed that predates it.
--
-- `prisma migrate dev` only diffs the schema, so it cannot write this: the
-- column was added nullable and nothing filled it, so every existing row reads
-- as « nobody has decided yet ». The four situation filters on the applicant's
-- screen then counted zero while the status totals counted the same rows.
--
-- The reason string derives it exactly. The platform's reasons are a closed set,
-- so each one maps to its source; anything else reached REJECTED through the
-- practice's own `reject`, which means the practice decided it. That is the
-- same distinction the account-erasure scrub already draws, and the one that
-- decides what it may erase.
--
-- Reversible: the column is derived, so `SET "decisionSource" = NULL` returns
-- the table to its previous state.

-- A retained placement is always the practice's decision.
UPDATE "application"
SET "decisionSource" = 'PRACTICE_ACCEPTED'
WHERE "status" = 'ACCEPTED' AND "decisionSource" IS NULL;

-- Self-service withdrawals. The only other writer of WITHDRAWN is the account
-- erasure, and it writes on the erased person's own rows, which the purge drops
-- along with the account — nobody ever reads that one.
UPDATE "application"
SET "decisionSource" = 'CANDIDATE_WITHDREW'
WHERE "status" = 'WITHDRAWN' AND "decisionSource" IS NULL;

-- The platform's own reasons, every spelling they were written in. Each is a
-- fact about the posting, not a judgement of the applicant, and misfiling one
-- as a refusal is what the whole column exists to prevent.
UPDATE "application" SET "decisionSource" = 'ANOTHER_CANDIDATE_SELECTED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL
  AND "rejectionReason" IN (
    'Un autre candidat a été retenu pour cette annonce',
    'Autre candidat retenu',
    'Another candidate was selected for this listing'
  );

UPDATE "application" SET "decisionSource" = 'LISTING_CLOSED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL
  AND "rejectionReason" = 'L''annonce a été clôturée';

UPDATE "application" SET "decisionSource" = 'LISTING_CLOSED_NO_CANDIDATE'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL
  AND "rejectionReason" = 'L''annonce a été clôturée, aucun remplaçant n''ayant été retenu';

UPDATE "application" SET "decisionSource" = 'LISTING_CANCELLED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL
  AND "rejectionReason" = 'L''annonce a été annulée';

UPDATE "application" SET "decisionSource" = 'LISTING_ERASED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL
  AND "rejectionReason" = 'L''annonce n''existe plus, le cabinet a fermé son compte';

-- Whatever REJECTED is left with came through the practice's own `reject`, with
-- their words or none. `accept`'s cascade and the listing teardown each write a
-- reason of their own, so nothing platform-written survives to here.
UPDATE "application"
SET "decisionSource" = 'PRACTICE_REJECTED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL;

-- PENDING and SHORTLISTED keep NULL deliberately: that is what « still open »
-- means, and it is the state a fresh application and a restored one both leave.
