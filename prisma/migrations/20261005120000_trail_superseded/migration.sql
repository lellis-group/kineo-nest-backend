-- Two truths the accountability trail could not previously record.
--
-- `EXECUTED` said the row had been acted on without saying what happened, and the
-- only other thing a row could be was pending. So a request that a newer one
-- replaced had nowhere to go: the second request's insert failed the partial
-- unique index on `userIdHash`, and the trail could either call the old row
-- executed — a lie — or leave it pending forever, so the link that confirmed it
-- executed a request nobody could see.
--
-- `ANONYMIZED` is what actually happened, in the words of the thing that did it.
-- `SUPERSEDED` is the fact that the row was replaced by a newer request, which is
-- not the same as having been carried out.
--
-- Renamed rather than re-added so the rows already written keep their history
-- instead of being reclassified.
ALTER TYPE "DataDeletionRequestStatus" RENAME VALUE 'EXECUTED' TO 'ANONYMIZED';
ALTER TYPE "DataDeletionRequestStatus" ADD VALUE 'SUPERSEDED';
