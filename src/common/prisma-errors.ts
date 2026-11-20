import { Prisma } from "../generated/prisma/client";

/**
 * Whether a write found no row to act on.
 *
 * `update` and `delete` accept non-unique fields next to the unique one in
 * their `where` (Prisma's `WhereUniqueInput`), and the whole filter is part of
 * the statement: a row that no longer matches it — deleted, moved to another
 * owner, answered in the meantime — fails the write with P2025 instead of
 * being overwritten.
 */
export function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}
