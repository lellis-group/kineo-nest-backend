export type ProfileDto = Record<string, unknown> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * The row the wire sees, and the row the schema demands.
 *
 * The `Profile` DTO is serialized by zod, and its timestamps are
 * `z.iso.datetime()` — a string, not a `Date`. The mapper is written once and
 * services hand every return site through it: the schema used to say
 * `z.date()`, which the OpenAPI generator refuses (a `Date` cannot be
 * represented in JSON Schema), and re-typing the schema alone would have left
 * the serializer refusing every response that carried the raw Prisma row.
 * Anything the schema does not name is stripped on the way out, so the spread
 * is safe to be wide.
 */
export function toProfileDto(profile: {
  createdAt: Date;
  updatedAt: Date;
}): ProfileDto {
  return {
    ...profile,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}
