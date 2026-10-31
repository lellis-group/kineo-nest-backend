export type ReplacementListingDto = Record<string, unknown> & {
  title: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The shape of the relation a listing query has to include.
 *
 * The full `Practice` row is narrowed to the fields the feed publishes: the DTO
 * is serialized by zod, so anything left on here that the schema does not name
 * is dropped on the way out — but there is no reason to read a column in order
 * to throw it away a moment later.
 */
type IncludedPractice = {
  id: string;
  name: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
};

export function toReplacementListingDto(listing: {
  title: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
  practice?: IncludedPractice;
  [key: string]: unknown;
}): ReplacementListingDto {
  const { practice, ...rest } = listing;

  return {
    ...rest,
    ...(practice
      ? {
          practice: {
            id: practice.id,
            name: practice.name,
            city: practice.city,
            latitude: practice.latitude,
            longitude: practice.longitude,
          },
        }
      : {}),
    startDate: listing.startDate.toISOString(),
    endDate: listing.endDate.toISOString(),
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}
