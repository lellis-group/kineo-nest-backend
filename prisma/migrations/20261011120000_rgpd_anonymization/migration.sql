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
-- nothing outside it can break. The three rows a local database holds are test
-- fixtures and go with it.
--
-- A database holding real requests cannot afford to lose them, and they cannot
-- be carried over here either: recomputing a fingerprint needs DELETION_PEPPER,
-- which by design never reaches the database. So the migration refuses to run
-- rather than dropping them, and the operator backfills first:
--
--   1. export DELETION_PEPPER
--   2. run the application backfill, which reads the old userId/email columns
--      and writes userIdHash/emailHash
--   3. re-run `prisma migrate deploy`
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
            'data_deletion_request is not empty. Backfill the fingerprints from DELETION_PEPPER before applying this migration; see the header.';
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
