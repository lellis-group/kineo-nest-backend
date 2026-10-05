import { Prisma } from "../generated/prisma/client";
import { longitudeRanges } from "./longitude-range";

/**
 * The geographic predicates, as SQL.
 *
 * They lived in the service as JavaScript: the service fetched a bounding box,
 * computed a distance per row, filtered, sorted and sliced in memory. Three
 * consequences, all of them wrong answers rather than slow ones — `name` and `city`
 * (fixed separately), a `total` that counted the fetched array rather than the
 * matches, and an arbitrary 500 candidates standing between the reader and the
 * nearest ones.
 *
 * So the distance moves into the query, where it belongs: the rows are ordered by
 * it and paged by the database, and the count is a real `COUNT(*)`. The bounding
 * box stays, and stays first, because it is what `@@index([latitude, longitude])`
 * can serve — the exact predicate runs on top of it to remove the corners of the
 * rectangle.
 *
 * Everything caller-supplied goes through a bound parameter. The two exceptions
 * are column names and the `ESCAPE` character, which the grammar requires as
 * literals; both are constants from this file, so neither adds an injection
 * surface.
 */

const EARTH_RADIUS_KM = 6_371;

/**
 * The escape character, as a SQL string literal: a quote, a backslash, a quote.
 *
 * Written with `String.fromCharCode` rather than `'\'` in the source, because
 * `"'\'"` in TypeScript is not what it looks like: `\'` is an escape sequence, so
 * the value comes out as two quotes and the statement runs with `ESCAPE ''`,
 * which Postgres accepts and which then reads every backslash literally.
 *
 * A bare backslash would not have worked either — `ESCAPE` wants a one-character
 * *literal*, and a bound parameter arrives as a value, which it also rejects.
 */
const BACKSLASH_ESCAPE_LITERAL = `'${String.fromCharCode(92)}'`;

/**
 * The columns a geographic search returns, in the order the entity declares them.
 *
 * Written out because `$queryRaw` cannot be handed a `select` object, and because
 * the row is then checked by the route's `PaginatedPractices` schema — so a
 * column missing from this list fails at the boundary rather than arriving
 * `undefined`.
 */
export const PRACTICE_GEO_COLUMNS =
  'p."id", p."ownerId", p."name", p."address", p."city", p."latitude", p."longitude", p."isPublic", p."createdAt"';

/** What a geographic row looks like once it has come back. */
export interface PracticeGeoRow {
  id: string;
  ownerId: string;
  name: string;
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  isPublic: boolean;
  createdAt: Date;
}

/**
 * The great-circle distance between the centre and a practice, in kilometres.
 *
 * The centre is converted to radians here, in JavaScript, and only the *difference*
 * is computed in SQL. Rounding the centre separately from the column would put
 * radians on one side of the subtraction and degrees on the other, which yields
 * thousands of kilometres rather than raising anything.
 *
 * This is the same formula `distanceInKm` used to run in JavaScript, term for
 * term: `sin(Δlat/2)² + cos(lat₁)·cos(lat₂)·sin(Δlng/2)²`, then `2R·asin(√a)`.
 */
export function haversineKm(lat: number, lng: number): Prisma.Sql {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const cosLat = Math.cos(latRad);

  // Column names cannot be bound — a placeholder arrives where the parser expects
  // a column — so they are inlined. They are literals from this file.
  const colLat = Prisma.raw('p."latitude"');
  const colLng = Prisma.raw('p."longitude"');

  return Prisma.sql`(
    ${EARTH_RADIUS_KM} * 2 * asin(
      sqrt(
        power(sin(radians(${colLat}) - ${latRad}) / 2, 2)
        + ${cosLat} * cos(radians(${colLat})) * power(sin(radians(${colLng}) - ${lngRad}) / 2, 2)
      )
    )
  )`;
}

/**
 * The longitude window, as one or two `BETWEEN` predicates.
 *
 * Built from `longitudeRanges`, which is where the wrap is worked out and where it
 * is tested. A plain interval cannot wrap: centred just west of the antimeridian it
 * asks for longitudes from 179.4 to 180.6, which no stored longitude satisfies — so
 * practices 44 km east of the line dropped out of both the page and the count.
 */
export function longitudeWindow(centre: number, delta: number): Prisma.Sql {
  const ranges = longitudeRanges(centre, delta);

  if (ranges.length === 1) {
    const [only] = ranges;
    return Prisma.sql`p."longitude" BETWEEN ${only.gte} AND ${only.lte}`;
  }

  const clauses = ranges.map(
    (range) => Prisma.sql`p."longitude" BETWEEN ${range.gte} AND ${range.lte}`,
  );

  return Prisma.sql`(${Prisma.join(clauses, " OR ")})`;
}

/**
 * A case-insensitive "contains" on a column, with the wildcards in the term
 * neutralised.
 *
 * A search for `100%` or `a_b` has to match those characters, not everything.
 *
 * Note the divergence this creates with the non-geographic branch, which uses
 * Prisma's `contains` and therefore does *not* neutralise them: `?name=%` lists
 * every practice there and `?name=%` with coordinates will not. Neither path has a
 * caller yet; when one does, the other has to move with it.
 */
export function containsInsensitive(
  column: '"name"' | '"city"',
  term: string,
): Prisma.Sql {
  return Prisma.sql`p.${Prisma.raw(column)} ILIKE ${`%${escapeLike(term)}%`} ESCAPE ${Prisma.raw(BACKSLASH_ESCAPE_LITERAL)}`;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Everything a geographic search filters on, built fresh for each statement. */
export function geoWhere(input: {
  lat: number;
  lng: number;
  radiusKm: number;
  latitudeDelta: number;
  longitudeDelta: number;
  name?: string;
  city?: string;
}): Prisma.Sql {
  const { lat, lng, radiusKm, latitudeDelta, longitudeDelta, name, city } =
    input;

  return Prisma.sql`
    p."isPublic" = true
    AND p."latitude" IS NOT NULL
    AND p."longitude" IS NOT NULL
    AND p."latitude" BETWEEN ${lat - latitudeDelta} AND ${lat + latitudeDelta}
    AND ${longitudeWindow(lng, longitudeDelta)}
    AND ${haversineKm(lat, lng)} <= ${radiusKm}
    ${name ? Prisma.sql`AND ${containsInsensitive('"name"', name)}` : Prisma.empty}
    ${city ? Prisma.sql`AND ${containsInsensitive('"city"', city)}` : Prisma.empty}
  `;
}
