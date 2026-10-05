-- Backfill: record who decided, for applications a cancelled listing rejected.
--
-- `close` has always written `decisionSource` on the applications it rejected;
-- `cancel` did not, so a cancellation left the column NULL. Anything reading
-- "who decided this" therefore answered differently for two ways of taking the
-- same listing out of circulation.
--
-- The predicate names the cancellation reason as well as the status, and that
-- redundancy is the point: `cancel` was the only writer that settled an
-- application without recording a source, but an irreversible data migration
-- should not rest on that having stayed true, so it selects what `cancel` wrote
-- and nothing else. Applications anonymised by the erasure path carry `SYSTEM`,
-- applications withdrawn carry `CANDIDATE_WITHDREW`, and practice refusals carry
-- `PRACTICE_REJECTED`, so no legitimate NULL is touched.
UPDATE "application"
SET "decisionSource" = 'PRACTICE_REJECTED'
WHERE "decisionSource" IS NULL
  AND "status" = 'REJECTED'
  AND "rejectionReason" = 'This listing was cancelled';