/**
 * Splits a longitude interval into the one or two ranges that cover it on the
 * circle.
 *
 * A plain `BETWEEN lng - d, lng + d` cannot wrap: centred just west of the
 * antimeridian it asks for longitudes from 179.4 to 180.6, which no stored
 * longitude satisfies, so practices 44 km east of the line were dropped from
 * both the page and the count — while the exact haversine predicate said they
 * were inside the radius.
 */
export function longitudeRanges(
  centre: number,
  delta: number,
): { gte: number; lte: number }[] {
  const west = centre - delta;
  const east = centre + delta;

  if (west >= -180 && east <= 180) {
    return [{ gte: west, lte: east }];
  }

  if (west < -180) {
    return [
      { gte: 180 + (west + 180), lte: 180 },
      { gte: -180, lte: east },
    ];
  }

  return [
    { gte: west, lte: 180 },
    { gte: -180, lte: -180 + (east - 180) },
  ];
}
