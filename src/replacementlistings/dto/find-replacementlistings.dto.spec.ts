/**
 * The browse filters, at the schema, before anything reaches a database.
 *
 * Two rules live here and nowhere else. The date pair has to be ordered, and the
 * three DTOs that read it have to keep saying it — the feed, the map and the
 * page-of read were written as three copies of one refinement, which is exactly
 * how two of them end up disagreeing with the third. A test per DTO is the
 * cheapest thing that notices a fourth copy appearing without it.
 *
 * And the boolean, which is not a refinement at all: `z.coerce.boolean()` reads
 * the literal string "false" as `true`, so `?urgent=false` would have shown the
 * urgent postings. Pinned here because the failure is invisible in a passing
 * test suite and very visible to the reader.
 */

import { describe, expect, it } from "bun:test";

import {
  FindPageOfSchema,
  FindPlacesSchema,
  FindReplacementListingsSchema,
} from "./find-replacementlistings.dto";

/** Every read that carries the date pair, with the fields each one requires. */
const readers = [
  { name: "the feed", schema: FindReplacementListingsSchema, extra: {} },
  { name: "the map", schema: FindPlacesSchema, extra: {} },
  {
    name: "the page-of read",
    schema: FindPageOfSchema,
    extra: { id: "listing-1" },
  },
] as const;

describe("the browse date pair", () => {
  for (const { name, schema, extra } of readers) {
    describe(name, () => {
      it("refuses a range that ends before it starts", () => {
        const result = schema.safeParse({
          ...extra,
          startDateFrom: "2026-12-01T00:00:00.000Z",
          startDateTo: "2026-11-01T00:00:00.000Z",
        });

        expect(result.success).toBe(false);
        const issues = result.error?.issues ?? [];
        // On `startDateTo`, not on both: the pair is the field the reader has
        // to change, and an error on `startDateFrom` would leave the offending
        // value sitting in the field box they have to fix.
        expect(issues[0]?.path).toEqual(["startDateTo"]);
        expect(issues[0]?.message).toBe(
          "startDateFrom must be on or before startDateTo",
        );
      });

      it("accepts a range that ends on or after it starts", () => {
        expect(
          schema.safeParse({
            ...extra,
            startDateFrom: "2026-11-01T00:00:00.000Z",
            startDateTo: "2026-11-01T00:00:00.000Z",
          }).success,
        ).toBe(true);
      });

      it("accepts one bound alone", () => {
        // Half a range is an open-ended one, and it is what the interface sends
        // while the reader is still choosing. Refusing it would break the filter
        // mid-interaction.
        expect(
          schema.safeParse({
            ...extra,
            startDateFrom: "2026-11-01T00:00:00.000Z",
          }).success,
        ).toBe(true);
        expect(
          schema.safeParse({
            ...extra,
            startDateTo: "2026-11-01T00:00:00.000Z",
          }).success,
        ).toBe(true);
      });
    });
  }
});

describe("the urgent filter", () => {
  it('reads the string "false" as false, not as true', () => {
    // `z.coerce.boolean()` is true for every non-empty string, so the naive
    // coercion turns "urgent=false" into "show me the urgent ones".
    const result = FindReplacementListingsSchema.parse({ urgent: "false" });

    expect(result.urgent).toBe(false);
  });

  it('reads the string "true" as true', () => {
    expect(FindReplacementListingsSchema.parse({ urgent: "true" }).urgent).toBe(
      true,
    );
  });

  it("refuses anything else rather than guessing", () => {
    expect(
      FindReplacementListingsSchema.safeParse({ urgent: "1" }).success,
    ).toBe(false);
    expect(
      FindReplacementListingsSchema.safeParse({ urgent: "yes" }).success,
    ).toBe(false);
  });

  it("leaves the filter off when the reader sends nothing", () => {
    expect(FindReplacementListingsSchema.parse({}).urgent).toBeUndefined();
  });
});

describe("the other browse filters", () => {
  it("trims the city and the free text", () => {
    const parsed = FindReplacementListingsSchema.parse({
      city: "  Lyon  ",
      q: "  dermatologue ",
    });

    expect(parsed.city).toBe("Lyon");
    expect(parsed.q).toBe("dermatologue");
  });

  it("refuses a filter it does not know", () => {
    // `.strict()`, because an unknown filter silently ignored is a filter the
    // reader believes is applied.
    expect(
      FindReplacementListingsSchema.safeParse({ radius: 10 }).success,
    ).toBe(false);
  });

  it("requires the posting on the page-of read, and refuses it empty", () => {
    expect(FindPageOfSchema.safeParse({}).success).toBe(false);
    expect(FindPageOfSchema.safeParse({ id: "listing-1" }).success).toBe(true);
    expect(FindPageOfSchema.safeParse({ id: "   " }).success).toBe(false);
  });

  it("refuses a page beyond the ceiling, on the paged reads", () => {
    // 100 pages of 500 rows is the whole bound; 1000 is a request for a payload
    // nobody wants, refused at the schema rather than at the database.
    expect(
      FindReplacementListingsSchema.safeParse({ page: 20, limit: 500 }).success,
    ).toBe(true);
    expect(
      FindReplacementListingsSchema.safeParse({ page: 1000, limit: 500 })
        .success,
    ).toBe(false);
  });

  it("has no paging on the map's read at all", () => {
    // The map reads the whole matching collection, so a page on it would be a
    // page of nothing.
    expect(FindPlacesSchema.safeParse({ page: 2 }).success).toBe(false);
    expect(FindPlacesSchema.safeParse({ limit: 50 }).success).toBe(false);
  });
});
