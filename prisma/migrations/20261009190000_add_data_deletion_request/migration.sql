-- CreateEnum
CREATE TYPE "DataDeletionRequestStatus" AS ENUM ('PENDING', 'EXECUTED');

-- CreateTable
CREATE TABLE "data_deletion_request" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "DataDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "data_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_deletion_request_userId_createdAt_idx" ON "data_deletion_request"("userId", "createdAt" DESC);

-- CreateIndex (partial: at most one pending request per user)
CREATE UNIQUE INDEX "data_deletion_request_userId_idx" ON "data_deletion_request"("userId") WHERE "status" = 'PENDING';