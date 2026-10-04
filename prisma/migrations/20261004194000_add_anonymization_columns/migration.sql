-- AlterTable
ALTER TABLE "data_deletion_request" ADD COLUMN     "emailHash" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3),
ADD COLUMN     "userIdHash" TEXT;
