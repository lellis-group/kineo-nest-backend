-- DropIndex
DROP INDEX "application_applicantId_idx";

-- DropIndex
DROP INDEX "profile_specialty_idx";

-- DropIndex
DROP INDEX "user_deletedAt_idx";

-- DropIndex
DROP INDEX "verification_identifier_idx";

-- CreateIndex
CREATE INDEX "data_deletion_request_emailHash_idx" ON "data_deletion_request"("emailHash");

-- CreateIndex
CREATE INDEX "profile_specialty_isPublic_idx" ON "profile"("specialty", "isPublic");

-- CreateIndex
CREATE INDEX "rl_status_created_id_desc_idx" ON "replacement_listing"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt") WHERE ("deletedAt" IS NOT NULL);

-- RenameIndex
ALTER INDEX "data_deletion_request_userIdHash_idx" RENAME TO "data_deletion_request_userIdHash_pending_key";

ALTER TABLE "replacement_listing"
  ADD CONSTRAINT "replacement_listing_dates_check" CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT "replacement_listing_max_applications_check" CHECK ("maxApplications" IS NULL OR "maxApplications" > 0);

ALTER TABLE "application"
  ADD CONSTRAINT "application_open_decision_source_check" CHECK ("status" NOT IN ('PENDING', 'SHORTLISTED') OR "decisionSource" IS NULL);