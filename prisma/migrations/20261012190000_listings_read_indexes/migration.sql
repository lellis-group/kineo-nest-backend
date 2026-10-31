-- Indexes for the browse read path. Every one of them is here because an
-- `EXPLAIN (ANALYZE, BUFFERS)` on the statement Prisma actually sends said the
-- plan needed it, and the two that already existed and said nothing were removed
-- for the same reason.

-- Why nothing below is partial, which is the whole point of this migration.
--
-- `status` is always sent as a parameter: Prisma emits
-- `WHERE status = CAST($1::text AS "ListingStatus")`. A partial index is only
-- usable when Postgres can prove its predicate holds for the rows the query
-- reads, and there is nothing in a parameter to reason with at plan time. Every
-- partial index on a status column in this schema was therefore unreachable by
-- the reads that declared it: measured on the application's own query shapes,
-- an index created as `WHERE status = 'OPEN'` was ignored the moment the
-- predicate was a parameter, and chosen the instant the same predicate was
-- spelled as a literal.
--
-- So these are plain indexes. A partial index that is never chosen costs writes
-- and answers nothing.

-- DropIndex
-- Two partial indexes on a status literal. `status` never arrives as a literal
-- through the API, and `rl_open_createdAt_idx` is now covered by the
-- `createdAt DESC, id DESC` index below — which also carries the tiebreaker
-- `orderByFor` always appends, and that the partial index never had.
DROP INDEX IF EXISTS "rl_open_createdAt_idx";

-- DropIndex
-- No read filters listings by IN_DISCUSSION: the status appears in the service
-- only as a value the recalculation writes, never as a query predicate.
DROP INDEX IF EXISTS "rl_indisc_createdAt_idx";

-- DropIndex
-- The practice's view of its candidates, which these two were declared for,
-- uses the `(listingId, applicantId)` unique index instead — Postgres picked it
-- on every shape measured, ordered by `createdAt DESC` or not, status
-- parameterised or not. Two indexes maintained on every application insert for
-- reads neither of them serves.
DROP INDEX IF EXISTS "app_listing_pending_idx";

-- DropIndex
DROP INDEX IF EXISTS "app_listing_shortlisted_idx";

-- DropIndex
-- The candidate's view takes `application_applicantId_status_idx`, a plain
-- two-column index: the bitmap index scan on it served the filtered, ordered,
-- paged read, and the partial twin was never chosen for it.
DROP INDEX IF EXISTS "app_applicant_pending_idx";

-- DropIndex
DROP INDEX IF EXISTS "app_applicant_shortlisted_idx";

-- CreateExtension
-- The city filter is a case-insensitive substring match (`contains … insensitive`
-- in the service), which no btree can serve: a btree serves prefixes, this asks
-- for "anywhere in the string". Trigram indexes exist for exactly that, and are
-- the only thing that turns a city search's practice scan into an index lookup.
-- `IF NOT EXISTS` so replaying on a database that already has it is a no-op.
--
-- The index is declared in schema.prisma with `type: Gin` and an `ops: raw(…)`
-- operator class — the extended-index syntax Prisma used to keep behind a
-- preview flag and now ships outright. `db:check` diffs the replayed history
-- against the schema, so an index that existed only here would read as a
-- difference and fail CI; the two are kept in step.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "practice_city_trgm_idx" ON "practice" USING gin ("city" gin_trgm_ops);

-- CreateIndex
-- The feed's default order. `id` is the second key because that is the
-- tiebreaker `orderByFor` always appends: an index that stops at `createdAt`
-- leaves Postgres a sort to finish, and it took the one below to prove that an
-- index only helps when it carries both keys. Measured: 0.05 ms against 4.7 ms
-- for sorting the collection.
CREATE INDEX "rl_created_id_desc_idx" ON "replacement_listing"("createdAt" DESC, "id" DESC);

-- CreateIndex
-- The `startDate` order, same shape. Measured: 0.07 ms against 0.77 ms for
-- sorting the collection.
CREATE INDEX "rl_startDate_id_desc_idx" ON "replacement_listing"("startDate" ASC, "id" DESC);

-- CreateIndex
-- The `urgent` order: urgent first, then soonest, then the tiebreaker. Measured:
-- 0.08 ms against a full sort to return ten rows.
CREATE INDEX "rl_urgent_startDate_id_idx" ON "replacement_listing"("urgent" DESC, "startDate" ASC, "id" DESC);
