/**
 * The rows third-party applications are parked on when their listing's owner
 * erases their account.
 *
 * Fixed ids rather than generated ones: this is one row per installation, the
 * application refers to it by id, and a random cuid would have to be read back
 * and threaded through every call site. `id` is TEXT, so the shape is free.
 *
 * These rows are created by `bun run db:seed`, which is a deploy step. Nothing
 * here creates them at runtime: a request must not be the thing that discovers
 * the scaffold is missing, and GhostListingService refuses instead.
 */
export const SYSTEM_SCAFFOLD = {
  userId: "kineo_system_account",
  profileId: "kineo_system_profile",
  practiceId: "kineo_system_practice",
  email: "system@deleted.invalid",
} as const;

export const GHOST_LISTING_TITLE = "Annonce retirée à la demande de son auteur";
