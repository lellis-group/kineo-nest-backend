import { createHmac } from "node:crypto";

/**
 * Keyed fingerprints for the account-erasure trail.
 *
 * Art. 5(2) asks for proof that an erasure happened; art. 5(1)(c) asks not to
 * keep the identifiers it happened to. Both are satisfied by storing an HMAC of
 * the identifier under a server-side pepper: the trail can still be searched for
 * "was this person processed?", and a database dump reveals neither the email
 * nor the pepper needed to reverse it.
 *
 * A bare hash would not do. The inputs here are emails and cuid identifiers,
 * which are enumerable from any other table of the same database, so an
 * unkeyed digest of them is reversible by anyone holding a dump.
 *
 * The pepper is deliberately never stored: losing it does not erase the trail,
 * it makes it unreachable, which is the honest failure mode for an
 * accountability record.
 */
export function deletionHash(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function deletionPepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = (env.DELETION_PEPPER ?? "").trim();

  if (!pepper) {
    throw new Error(
      "DELETION_PEPPER is required: without it the erasure trail cannot be keyed, and an unkeyed hash of an email is reversible",
    );
  }

  if (pepper.length < 32) {
    throw new Error(
      `DELETION_PEPPER must be at least 32 characters, got ${pepper.length}`,
    );
  }

  return pepper;
}
