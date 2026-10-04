type ListingRow = {
  title: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
};

/**
 * The row with its four dates as strings.
 *
 * Spelled out because spreading an indexed type drops the index signature, so
 * the inferred return described only the fields this function rewrites — `id`,
 * `status` and the rest were invisible to the type system everywhere. `Omit`
 * keeps the index: `keyof` an indexed type is `string | number`, so excluding
 * the four date keys leaves it intact.
 */
type ListingDto = Omit<
  ListingRow,
  "startDate" | "endDate" | "createdAt" | "updatedAt"
> & {
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
};

export function toReplacementListingDto(listing: ListingRow): ListingDto {
  return {
    ...listing,
    startDate: listing.startDate.toISOString(),
    endDate: listing.endDate.toISOString(),
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}
