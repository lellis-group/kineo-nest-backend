import { createHmac } from "node:crypto";

import { ServiceUnavailableException } from "@nestjs/common";

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

/**
 * Raised when the pepper is absent or too short, instead of a plain `Error`.
 *
 * The erasure controller already documents a 503 for exactly this precondition;
 * a plain `Error` went through the global filter as a 500, which a hardened
 * environment rewrites into "Internal server error" — a body that names neither
 * the cause nor the fact that the caller's inputs are fine and the installation
 * is misconfigured. The same shape `ServiceUnavailableScaffoldError` draws for
 * the scaffold, for the same kind of precondition.
 *
 * The message still tells whoever reads the log what to do, which is the only
 * place it is visible: a hardened body does not carry it.
 */
export class DeletionPepperError extends ServiceUnavailableException {
  constructor(message: string) {
    super(message);
    this.name = "DeletionPepperError";
  }
}

export function deletionPepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = (env.DELETION_PEPPER ?? "").trim();

  if (!pepper) {
    throw new DeletionPepperError(
      "DELETION_PEPPER is required: without it the erasure trail cannot be keyed, and an unkeyed hash of an email is reversible",
    );
  }

  if (pepper.length < 32) {
    throw new DeletionPepperError(
      `DELETION_PEPPER must be at least 32 characters, got ${pepper.length}`,
    );
  }

  return pepper;
}
