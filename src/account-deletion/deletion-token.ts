/** Prefix of the single-use deletion token rows in the `verification` table. */
export const DELETE_ACCOUNT_IDENTIFIER_PREFIX = "delete-account-";

export function deleteAccountIdentifier(token: string): string {
  return `${DELETE_ACCOUNT_IDENTIFIER_PREFIX}${token}`;
}

/**
 * The rows to purge for an identity that no longer exists.
 *
 * `verification` has no foreign key to `user`, so nothing removes the tokens for
 * an erased account on its own: the email verification and password reset rows
 * are keyed by the raw address, and the deletion links by the user id in `value`.
 *
 * The prefix match has to be its own clause. Filtering
 * `{ identifier: { startsWith: prefix, value: userId } }` reads as a range on
 * identifier plus an unknown `value` option, which Prisma rejects at runtime.
 */
export function verificationRowsForIdentity(email: string, userId: string) {
  return {
    OR: [
      { identifier: email },
      {
        AND: [
          { identifier: { startsWith: DELETE_ACCOUNT_IDENTIFIER_PREFIX } },
          { value: userId },
        ],
      },
    ],
  };
}
