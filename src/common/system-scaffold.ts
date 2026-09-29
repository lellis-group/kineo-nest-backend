/**
 * Identifiers of the system scaffold rows, seeded once by the
 * `system_scaffold` migration.
 *
 * Referenced by id rather than looked up: the ghost listings created during an
 * erasure point at the practice, and reading it back per erasure would be one
 * extra query for a value that can never change.
 *
 * Nothing here is ever shown as authored content or edited by a person. The
 * practice's name is what a candidate reads under their own application, which
 * is why it is a sentence rather than an identifier.
 */
export const SYSTEM_SCAFFOLD = {
  userId: "kineo_system_account",
  profileId: "kineo_system_profile",
  practiceId: "kineo_system_practice",
} as const;

/**
 * Title of a ghost listing.
 *
 * Neutral on purpose: the copy is created after the erasure has rewritten the
 * original, and it must not carry any of the practice's own content — the
 * candidate keeps the status, the reason, their message and the timestamps,
 * which is what lets them challenge the outcome.
 */
export const GHOST_LISTING_TITLE = "Annonce retirée";
