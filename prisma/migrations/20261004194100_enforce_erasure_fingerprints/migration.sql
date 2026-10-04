-- DropIndex
DROP INDEX "verification_identifier_idx";

-- DropIndex
DROP INDEX "data_deletion_request_userId_createdAt_idx";

-- DropIndex
DROP INDEX "data_deletion_request_userId_idx";

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "data_deletion_request" DROP COLUMN "email",
DROP COLUMN "userId",
ALTER COLUMN "userIdHash" SET NOT NULL,
ALTER COLUMN "emailHash" SET NOT NULL,
ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");

-- CreateIndex
CREATE INDEX "verification_identifier_expiresAt_idx" ON "verification"("identifier", "expiresAt");

-- CreateIndex
CREATE INDEX "data_deletion_request_userIdHash_createdAt_idx" ON "data_deletion_request"("userIdHash", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "data_deletion_request_status_updatedAt_idx" ON "data_deletion_request"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "data_deletion_request_userIdHash_idx" ON "data_deletion_request"("userIdHash") WHERE ("status" = 'PENDING');
