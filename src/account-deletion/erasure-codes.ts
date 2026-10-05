/**
 * Machine-readable failure codes for the erasure confirmation.
 *
 * A single status is not enough here, and the reason is specific rather than
 * general. This endpoint answers 404 and 410 for outcomes that call for
 * opposite things from the reader: a link that was never valid means start over,
 * a link that worked once means the account is already gone and there is nothing
 * to do. The frontend has a screen for each — `no-pending-request` tells them to
 * request again, `already-erased` tells them there is nothing to remove — and it
 * can only choose between them on a code.
 *
 * Declared here rather than in the service so the contract has one name, and so
 * the frontend's mirror has a single counterpart to point at. `THIRD_PARTY_APPLICATIONS`
 * is deliberately absent: this version detaches other candidates' applications
 * onto ghost listings instead of refusing, so there is no third-party conflict
 * to report. The frontend keeps handling that code for a backend one deploy
 * behind.
 */
export const ERASURE_ERROR_CODES = {
  /** No `PENDING` trail row matches this link: never valid, or already consumed. */
  NO_PENDING_REQUEST: "NO_PENDING_REQUEST",
  /** The link was valid but its 24 hours ran out. A new one can be requested. */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** The account is already anonymized. There is nothing left to remove. */
  ALREADY_ERASED: "ALREADY_ERASED",
} as const;

export type ErasureErrorCode =
  (typeof ERASURE_ERROR_CODES)[keyof typeof ERASURE_ERROR_CODES];
