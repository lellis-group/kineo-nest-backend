-- CreateEnum
--
-- The candidate's screen had five flat statuses and no way to tell who decided.
-- `REJECTED` covered four situations that read very differently to the person
-- who applied: another candidate was retained, the posting ended with nobody
-- chosen, the practice gave up on the replacement, or the practice refused them
-- in its own words. `WITHDRAWN` mixed a self-service withdrawal with one written
-- by the account erasure. The front could only have guessed from the reason
-- string, which is free text the practice types.
--
-- This column is that fact, stored rather than inferred. Null while the
-- application is still open (PENDING, SHORTLISTED): there is no decision yet.
CREATE TYPE "ApplicationDecisionSource" AS ENUM ('CANDIDATE_WITHDREW', 'PRACTICE_ACCEPTED', 'PRACTICE_REJECTED', 'ANOTHER_CANDIDATE_SELECTED', 'LISTING_CLOSED', 'LISTING_CLOSED_NO_CANDIDATE', 'LISTING_CANCELLED', 'LISTING_ERASED', 'CANDIDATE_UNAVAILABLE');

-- AlterTable
ALTER TABLE "application" ADD COLUMN     "decisionSource" "ApplicationDecisionSource";
