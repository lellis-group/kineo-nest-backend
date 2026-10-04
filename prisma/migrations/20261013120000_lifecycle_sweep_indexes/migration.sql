-- Indexes for the hourly retention sweep.
--
-- `purgeExpired` runs every hour in the process that serves requests and
-- deletes on `expiresAt` alone, on both tables. Neither had an index on that
-- column, so each sweep was a sequential scan followed by a single unbounded
-- DELETE.
--
-- `verification_identifier_expiresAt_idx` is a btree on (identifier, expiresAt).
-- The existing index on `identifier` alone is a HASH, which Postgres cannot use
-- for the erasure's `identifier LIKE 'delete-account-%' OR identifier LIKE
-- 'reset-password:%'` — a hash index serves equality only, never a prefix
-- range. The erasure runs that query inside a Serializable transaction with a
-- 10s timeout, so an unindexed scan there is a request that times out under
-- load. A btree serves both the equality lookups and the prefix range.

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");

-- CreateIndex
CREATE INDEX "verification_identifier_expiresAt_idx" ON "verification"("identifier", "expiresAt");
