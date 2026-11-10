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

/**
 * Decimal places a public profile's coordinates keep: two, about a kilometre.
 *
 * A profile is a person, and its coordinates are wherever that person chose to
 * be found from — often home. Another member searching by area needs the
 * neighbourhood, never the doorstep, so the public view rounds them; the exact
 * values stay on the owner's own `GET /profile/me`.
 */
export const PUBLIC_COORDINATE_DECIMALS = 2;

function blurCoordinate(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const factor = 10 ** PUBLIC_COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** The profile as another member sees it: `toProfileDto`, coordinates blurred. */
export function toPublicProfileDto(profile: {
  createdAt: Date;
  updatedAt: Date;
  latitude?: number | null;
  longitude?: number | null;
}): ProfileDto {
  return {
    ...toProfileDto(profile),
    latitude: blurCoordinate(profile.latitude),
    longitude: blurCoordinate(profile.longitude),
  };
}
