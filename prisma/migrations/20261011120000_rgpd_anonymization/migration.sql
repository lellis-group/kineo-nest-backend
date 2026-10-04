-- GDPR erasure: identifiers in the deletion audit trail become keyed
-- fingerprints, and the account gains a deferred-purge marker.
--
-- The fingerprints are HMAC-SHA256 values computed by the application with a
-- server-side pepper (DELETION_PEPPER). They cannot be produced here: the
-- pepper deliberately never reaches the database, which is what stops a dump
-- from revealing who asked for erasure.
--
-- The audit table is therefore dropped and recreated rather than altered. It
-- has no foreign key, no incoming reference and only a handful of rows, so
-- nothing outside it can break.
--
-- A populated table cannot afford to lose them, and its rows cannot be carried
-- over here either: recomputing a fingerprint needs DELETION_PEPPER, which by
-- design never reaches the database. So the guard below refuses to run rather
-- than dropping them, and says what to do. That should never be reached — the
-- only realistic way to get here is restoring a database that was live after
-- this migration shipped. See README §4.5 for the backfill.
--
-- Failing loudly is the point. Silently destroying the art. 5(2)
-- accountability record is the one outcome nobody can recover from.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- Guard: refuse to destroy a populated audit trail
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "data_deletion_request" LIMIT 1) THEN
        RAISE EXCEPTION
            'data_deletion_request is not empty. This is the art. 5(2) accountability trail, so it is not dropped. Backfill userIdHash/emailHash from DELETION_PEPPER, then re-run (README 4.5).';
    END IF;
END
$$;

-- DropTable
DROP TABLE IF EXISTS "data_deletion_request";

-- DropEnum
DROP TYPE IF EXISTS "DataDeletionRequestStatus";

-- CreateEnum
CREATE TYPE "DataDeletionRequestStatus" AS ENUM ('PENDING', 'ANONYMIZED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "data_deletion_request" (
    "id" TEXT NOT NULL,
    "userIdHash" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "status" "DataDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "data_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_deletion_request_userIdHash_createdAt_idx" ON "data_deletion_request"("userIdHash", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "data_deletion_request_status_updatedAt_idx" ON "data_deletion_request"("status", "updatedAt");

-- CreateIndex (partial: at most one pending request per user)
CREATE UNIQUE INDEX "data_deletion_request_userIdHash_idx" ON "data_deletion_request"("userIdHash") WHERE "status" = 'PENDING';
