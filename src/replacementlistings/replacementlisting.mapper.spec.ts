/**
 * The mapper every listing answer goes through.
 *
 * This is the file whose two branches the delete route fell between on the
 * revision CI tested: a write returns a Prisma row with no `practice` included,
 * and the DTO schema required one — so a route that had worked for months
 * answered 500 the day the schema changed. The unit suite could not have seen
 * it, because the mapper itself never failed: it returned a listing with no
 * `practice` key, which is exactly right for its own contract and fatal for the
 * schema's.
 *
 * So what is pinned here is the contract, not the output: the key is *absent*
 * when the relation was not loaded, present and reduced when it was, and the
 * dates are always ISO strings. A change that turns the absence into an
 * explicit `undefined` — which looks identical to a reader and is not identical
 * to zod — fails here.
 */

import { describe, expect, it } from "bun:test";

import { toReplacementListingDto } from "./replacementlisting.mapper";

const listing = {
  id: "listing-1",
  practiceId: "practice-1",
  title: "Remplacement généraliste",
  startDate: new Date("2026-11-02T00:00:00.000Z"),
  endDate: new Date("2026-11-16T00:00:00.000Z"),
  specialty: "GENERALIST",
  status: "OPEN",
  urgent: false,
  description: null,
  maxApplications: 3,
  createdAt: new Date("2026-08-20T08:00:00.000Z"),
  updatedAt: new Date("2026-08-21T09:30:00.000Z"),
};

describe("toReplacementListingDto", () => {
  it("serializes the four dates as ISO instants", () => {
    const dto = toReplacementListingDto(listing);

    expect(dto.startDate).toBe("2026-11-02T00:00:00.000Z");
    expect(dto.endDate).toBe("2026-11-16T00:00:00.000Z");
    expect(dto.createdAt).toBe("2026-08-20T08:00:00.000Z");
    expect(dto.updatedAt).toBe("2026-08-21T09:30:00.000Z");
  });

  /**
   * The half of the contract a write depends on.
   *
   * Not `practice: undefined` and not `practice: null`: the key is absent, which
   * is the only shape a schema declaring the relation optional accepts. The
   * difference is invisible in a printed object and decides whether the route
   * answers 200 or 500.
   */
  it("omits the practice key entirely when the relation was not loaded", () => {
    const dto = toReplacementListingDto(listing);

    expect("practice" in dto).toBe(false);
    expect(Object.keys(dto)).not.toContain("practice");
  });

  it("publishes the practice when the query included it", () => {
    const dto = toReplacementListingDto({
      ...listing,
      practice: {
        id: "practice-1",
        name: "Cabinet Medical",
        city: "Lyon",
        latitude: 45.75,
        longitude: 4.85,
        // Read by a query that selected the whole row rather than the five
        // published fields: the DTO drops them, and the street address is
        // exactly the kind of thing not to reach a public feed by accident.
        address: "1 rue de la Paix",
        isPublic: true,
      },
      // The mapper's own type narrows the relation to what it publishes; a query
      // returning the full row is the case worth testing, so the row is widened
      // here on purpose.
    } as unknown as Parameters<typeof toReplacementListingDto>[0]);

    expect(dto.practice).toEqual({
      id: "practice-1",
      name: "Cabinet Medical",
      city: "Lyon",
      latitude: 45.75,
      longitude: 4.85,
    });
  });

  it("keeps a practice that has no coordinates, nulls included", () => {
    const dto = toReplacementListingDto({
      ...listing,
      practice: {
        id: "practice-1",
        name: "Cabinet Medical",
        city: "Lyon",
        latitude: null,
        longitude: null,
      },
    });

    // Nulls rather than a missing key: the schema declares these nullable, and
    // a practice that cannot be placed is a real answer to publish, not an
    // absence.
    expect(dto.practice).toMatchObject({
      latitude: null,
      longitude: null,
    });
  });

  it("passes the listing's own fields through, count included", () => {
    const dto = toReplacementListingDto({
      ...listing,
      applicationsCount: 2,
    });

    expect(dto).toMatchObject({
      id: "listing-1",
      practiceId: "practice-1",
      title: "Remplacement généraliste",
      status: "OPEN",
      specialty: "GENERALIST",
      description: null,
      maxApplications: 3,
      applicationsCount: 2,
    });
  });

  it("does not rewrite the dates it was given", () => {
    // A write record and a row read back carry the same instants; the mapper
    // only changes their type. A second conversion here would be the kind of
    // shift that moves a listing across a date boundary in the feed.
    const dto = toReplacementListingDto(listing);

    expect(new Date(dto.startDate).getTime()).toBe(listing.startDate.getTime());
    expect(new Date(dto.endDate).getTime()).toBe(listing.endDate.getTime());
  });
});
