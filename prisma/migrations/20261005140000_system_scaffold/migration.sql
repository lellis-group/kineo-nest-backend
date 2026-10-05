-- The three fixed rows an account erasure parks other candidates' applications on.
--
-- These were created by `bun run db:seed` and by nothing else, which made the
-- scaffold a deploy step a migration is supposed to be: a deployment that ran
-- `migrate deploy` and stopped — the normal one — had no scaffold, and every
-- erasure of an account whose listing carried somebody else's application failed
-- with `ServiceUnavailableScaffoldError` and nothing in the logs naming the row
-- that was missing.
--
-- A migration, not only the seed, because the seed is optional and this is not.
-- The seed stays and stays idempotent: `ON CONFLICT DO NOTHING` is what makes
-- running either twice safe, and the two agree on the fixed ids by construction.
--
-- `deletedAt` stays NULL on the user row: the purge sweep matches on that column,
-- and this row must never be a candidate for it.
INSERT INTO "user" ("id", "email", "emailVerified", "createdAt", "updatedAt")
VALUES (
  'kineo_system_account',
  'system@deleted.invalid',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "profile" (
  "id", "userId", "specialty", "profileType", "verified", "isPublic", "createdAt", "updatedAt"
)
VALUES (
  'kineo_system_profile',
  'kineo_system_account',
  'GENERALIST',
  'INSTALLED',
  true,
  false,
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "practice" ("id", "ownerId", "name", "address", "city", "isPublic", "createdAt")
VALUES (
  'kineo_system_practice',
  'kineo_system_profile',
  'System (withdrawn listings)',
  '-',
  '-',
  false,
  NOW()
)
ON CONFLICT ("id") DO NOTHING;
