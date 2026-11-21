-- CreateEnum
CREATE TYPE "StoredFileKind" AS ENUM ('AVATAR', 'LISTING_IMAGE', 'CV');

-- CreateTable
CREATE TABLE "stored_file" (
    "id" TEXT NOT NULL,
    "kind" "StoredFileKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "uploaderId" TEXT NOT NULL,
    "profileId" TEXT,
    "listingId" TEXT,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_storageKey_key" ON "stored_file"("storageKey");

-- CreateIndex
CREATE INDEX "stored_file_profileId_kind_idx" ON "stored_file"("profileId", "kind");

-- CreateIndex
CREATE INDEX "stored_file_listingId_kind_idx" ON "stored_file"("listingId", "kind");

-- CreateIndex
CREATE INDEX "stored_file_applicationId_kind_idx" ON "stored_file"("applicationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_avatar_profile_key" ON "stored_file"("profileId") WHERE ("kind" = 'AVATAR');

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "replacement_listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
