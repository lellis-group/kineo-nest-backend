-- CreateEnum
CREATE TYPE "DecisionSource" AS ENUM ('PRACTICE_ACCEPTED', 'PRACTICE_REJECTED', 'CANDIDATE_WITHDREW', 'SYSTEM');

-- AlterEnum
ALTER TYPE "ListingStatus" ADD VALUE 'CLOSED_NO_CANDIDATE';

-- AlterTable
ALTER TABLE "application" ADD COLUMN     "decisionSource" "DecisionSource";

-- CreateIndex
CREATE INDEX "application_applicantId_status_idx" ON "application"("applicantId", "status");
