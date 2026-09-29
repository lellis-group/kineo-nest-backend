import { createHmac } from "node:crypto";

const ANONYMIZED_EMAIL_DOMAIN = "deleted.invalid";
const ANONYMIZED_EMAIL_LOCAL_PREFIX = "deleted+";
const ANONYMIZED_EMAIL_LOCAL_SUFFIX_LENGTH = 16;

/**
 * Keyed fingerprint of a direct identifier, used by the deletion audit trail
 * (art. 5(2) accountability without art. 17 erasure).
 *
 * HMAC rather than a bare digest: emails and user ids are low-entropy values,
 * so a plain hash can be reversed with a dictionary. The pepper stays in the
 * environment and never reaches the database, which also means a database dump
 * alone cannot be used to confirm whether a given person asked for erasure.
 *
  * Losing the pepper does not lose the audit trail, it makes it
  * unreachable. Not "unsearchable": the confirmation matches on
  * `deletionHash(userId, pepper)`, so a rotated or absent pepper stops every
  * future confirmation from finding its pending request, and each one fails
  * with a conflict until the person requests erasure again. The trail rows
  * survive; the flow that consumes them does not. Back the pepper up
  * alongside the database, and treat losing it as a production incident.
  *
  * An empty pepper is rejected upstream, at the call sites: `createHmac` would
  * happily accept one and produce a well-formed but unkeyed digest, which is
  * exactly the dictionary-reversible case this function exists to prevent.
  */
export function deletionHash(value: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(value.trim().toLowerCase())
    .digest("hex");
}

/**
 * Replacement email written over `user.email` when the account is anonymized.
 *
 * Deterministic in the user id so the same account always maps to the same
 * value, which keeps the unique index satisfiable while staying free of any
 * trace back to the real address. `@invalid` is reserved by RFC 2606 and can
 * never be a real deliverable domain, so the address cannot receive mail or be
 * registered by a third party. Keeping the value means the original address is
 * released immediately and the person can re-register right away.
 */
export function anonymizedEmailFor(userId: string, pepper: string): string {
  const local = deletionHash(userId, pepper).slice(
    0,
    ANONYMIZED_EMAIL_LOCAL_SUFFIX_LENGTH,
  );

  return `${ANONYMIZED_EMAIL_LOCAL_PREFIX}${local}@${ANONYMIZED_EMAIL_DOMAIN}`;
}
