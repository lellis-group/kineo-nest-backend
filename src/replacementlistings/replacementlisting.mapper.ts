export type ReplacementListingDto = Record<string, unknown> & {
  title: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
};

export function toReplacementListingDto(listing: {
  title: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}): ReplacementListingDto {
  return {
    ...listing,
    startDate: listing.startDate.toISOString(),
    endDate: listing.endDate.toISOString(),
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}
