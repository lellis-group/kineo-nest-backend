-- Data migration: derive `decisionSource` on rows written before the column.
--
-- The column was added nullable and nothing backfilled it, so every application
-- written before this migration carries NULL — which reads as "nobody has
-- decided yet". The four situation filters on the applicant's screen then
-- counted zero while the status totals counted the same rows, and the chips
-- summed to 213 against a total of 300.
--
-- The reason string is enough to derive it, because the platform's reasons are
-- a closed set. Anything else is a practice's own words, which means the
-- practice decided it. There is no guesswork beyond that one distinction, and
-- it is the same one the erasure scrub already draws.
--
-- Reversible: the column is derived, so `UPDATE ... SET "decisionSource" = NULL`
-- returns the table to its previous state.

-- Retained candidates. A retained placement is always the practice's decision.
UPDATE "application"
SET "decisionSource" = 'PRACTICE_ACCEPTED'
WHERE "status" = 'ACCEPTED' AND "decisionSource" IS NULL;

-- Self-service withdrawals. The other writer of WITHDRAWN is the account
-- erasure, and it writes on the erased person's own rows, which the purge
-- drops with the account — nobody ever reads that one.
UPDATE "application"
SET "decisionSource" = 'CANDIDATE_WITHDREW'
WHERE "status" = 'WITHDRAWN' AND "decisionSource" IS NULL;

-- The platform's own reasons, each spelling, in the order they were written.
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

-- Whatever is left under REJECTED reached it through the practice's own
-- `reject`, free text or none. `accept`'s cascade and the listing teardown both
-- write a reason of their own, so nothing platform-written is left to
-- misclassify here.
UPDATE "application"
SET "decisionSource" = 'PRACTICE_REJECTED'
WHERE "status" = 'REJECTED' AND "decisionSource" IS NULL;

-- PENDING and SHORTLISTED keep NULL on purpose: that is what "still open" means,
-- and it is the state a fresh application and a restored one both leave.
