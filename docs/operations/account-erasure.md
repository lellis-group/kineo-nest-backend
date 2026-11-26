# Account erasure

[Documentation index](../README.md) - [Security and reliability](security.md) - [Data model](../architecture/data-model.md)

The endpoint is `POST /account/confirm-deletion`, with the token from the emailed link. No session is required: better-auth's own `delete-user` demands a valid cookie at click time, which answers "invalid link" from a different browser or with a blocked cookie. The emailed token is the proof of identity.

Hard deletion is refused by `deleteUser.beforeDelete`. Anonymization is the only path.

## Procedure

The endpoint does the following, in order.

1. **Consume the token.** The single-use `delete-account-*` token is checked and expired tokens are refused.
2. **Park third-party applications.** Applications other candidates wrote on this account's listings move to a ghost listing owned by the system scaffold. They are not the account holder's data to erase, so both their authors and the practices that received them keep a real row. An `ACCEPTED` application on a `FILLED` listing is never moved: the candidate is waiting on that listing and it carries no undecided answer.
3. **Anonymize.** The address becomes `erased-<fingerprint>@deleted.invalid`; the name and image go; the profile loses its RPPS number, city, and coordinates; the account's own applications are settled so their listings recalculate.
   - A listing still circulating loses its title, description, and dates and stops being shown (`CLOSED_NO_CANDIDATE`).
   - A listing already past its end (`CLOSED`, `CANCELLED`, or a protected placement) is scrubbed of the owner's words only: the status it was closed with is part of the trail.
   - Candidacies parked on a ghost that nobody can decide any more (`PENDING`, `SHORTLISTED`) are settled `REJECTED` with `decisionSource = SYSTEM`. The account that would have answered is gone, and an open row would queue the candidate's own application quota for nothing.
4. **Drop sessions and credentials.** The erasure takes effect immediately.
5. **Set `deletedAt`.** The hourly sweep drops the row after `ACCOUNT_PURGE_GRACE_DAYS`.

### Accepted placements

A listing holding an accepted placement is deliberately left alone. The placement was agreed with a candidate still waiting for an answer, so the listing leaves circulation rather than being scrubbed, and the response reports how many there are.

> **Decision** - This is "F2, option A" from the 2026 hardening audit: never detach an `ACCEPTED` application from a `FILLED` listing. The placement is a verifiable fact, and `accept` has already settled the other active applications that could have been stranded behind it.

## Audit trail

The `DataDeletionRequest` trail stores two keyed fingerprints, not identifiers:

```text
userIdHash = HMAC-SHA256(DELETION_PEPPER, userId)
emailHash  = HMAC-SHA256(DELETION_PEPPER, email)
```

An unkeyed hash would not do: the inputs are emails and cuid identifiers, enumerable from any other table in the same dump. `emailHash` is written and never read by the application; it exists so an operator can answer a question without taking a dump.

> **Warning** - Back up `DELETION_PEPPER` with the database. Losing it does not erase the trail, it makes the trail unreachable: nothing can compute the fingerprint to search for.

To answer "was this person processed?", compute the fingerprint and query:

```sql
SELECT "status", "createdAt", "executedAt"
FROM "data_deletion_request"
WHERE "emailHash" = '<HMAC-SHA256 of the address under the pepper>';
```

## When the trail migration stops halfway

The two migrations around the trail are split on purpose. The first adds nullable fingerprint columns; the second makes them `NOT NULL` and drops the plaintext `userId` and `email`. A database still holding trail rows fails the second migration rather than losing them: an accountability record is not ours to rewrite.

If `bun run db:migrate` reports a failure in `enforce_erasure_fingerprints`, on a development database recompute the fingerprints and retry:

```bash
DELETION_PEPPER=<the real pepper> bun run db:seed
bun run db:migrate
```

> **Warning** - `db:seed` wipes the rest of the data. On anything but a development database, run the backfill by hand instead, one row at a time, with fingerprints computed by your own script:

```sql
UPDATE "data_deletion_request"
SET "userIdHash" = '<hmac>', "emailHash" = '<hmac>', "updatedAt" = NOW()
WHERE "userIdHash" IS NULL;
```

The sweep that bounds token lifetimes, the ghost-listing repair at boot, and the keyed-trail behavior are covered by the e2e suite; see [Testing and CI](testing.md).
