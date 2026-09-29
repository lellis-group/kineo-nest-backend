-- System scaffold: the owner row that third-party applications are detached to
-- when an account is erased (art. 17 GDPR).
--
-- The erasure cascade is `User -> Profile -> Practice -> ReplacementListing ->
-- Application`, so an application on the erased account's listing dies with it —
-- and that application belongs to someone else. Before anonymizing, those rows
-- are moved onto a ghost listing created here, so the cascade can no longer
-- reach them.
--
-- Three rows are needed, not one: `Profile.userId` is required and cascades
-- from `User`, and `ReplacementListing` needs both a `practiceId` and a
-- `createdById`. None of them is ever shown or edited by a person.
--
-- Ids are fixed rather than generated: this is a one-per-installation row, and
-- the application refers to it by id, so a random cuid would have to be read
-- back and threaded through. `id` is TEXT, so the shape is free.
--
-- Idempotent, so a re-run is harmless.

-- The system account. `deletedAt` stays NULL: it is not an erased account, and
-- the purge sweep matches on that column.
INSERT INTO "user" ("id", "email", "createdAt", "updatedAt")
VALUES (
    'kineo_system_account',
    'system@deleted.invalid',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- specialty and profileType are required, non-nullable enums with no neutral
-- member, so sentinels are unavoidable. `OTHER` is the closest to "not a
-- practitioner" for the specialty. `isPublic` defaults to true, so it is set
-- explicitly: a public directory entry for a system row would be a bug.
INSERT INTO "profile" (
    "id", "userId", "specialty", "profileType", "verified", "isPublic",
    "createdAt", "updatedAt"
)
VALUES (
    'kineo_system_profile',
    'kineo_system_account',
    'OTHER',
    'INSTALLED',
    false,
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- Ghost listings belong here. The name is what a candidate reads under the
-- listing on their own applications page, so it is a sentence rather than a
-- technical label.
-- No `updatedAt`: `Practice` has never carried one, unlike `User` and `Profile`.
INSERT INTO "practice" (
    "id", "ownerId", "name", "address", "city", "isPublic", "createdAt"
)
VALUES (
    'kineo_system_practice',
    'kineo_system_profile',
    'Annonce retirée par son auteur',
    '—',
    '—',
    false,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;
