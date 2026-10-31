export type PracticeDto = Record<string, unknown> & {
  createdAt: string;
};

/**
 * The row the wire sees, and the row the schema demands.
 *
 * The `Practice` DTO is serialized by zod, and its timestamps are
 * `z.iso.datetime()` — a string, not a `Date`. The reason a mapper exists
 * rather than a schema edit: the raw Prisma row the services return held
 * `Date` objects, which the OpenAPI generator cannot express (and the
 * serializer would refuse). Anything the schema does not name is stripped on
 * the way out, so the spread is safe to be wide.
 */
export function toPracticeDto(practice: { createdAt: Date }): PracticeDto {
  return {
    ...practice,
    createdAt: practice.createdAt.toISOString(),
  };
}
