import { describe, expect, it } from "bun:test";
import { longitudeRanges } from "./longitude-range";

describe("longitudeRanges", () => {
  it("is a single interval away from the edges", () => {
    expect(longitudeRanges(2.35, 1)).toEqual([{ gte: 1.35, lte: 3.35 }]);
  });

  it("is a single interval on the prime meridian", () => {
    expect(longitudeRanges(0, 5)).toEqual([{ gte: -5, lte: 5 }]);
  });

  it("splits into two intervals across the antimeridian", () => {
    expect(longitudeRanges(179.5, 1)).toEqual([
      { gte: 178.5, lte: 180 },
      { gte: -180, lte: -179.5 },
    ]);
  });

  it("splits into two intervals across the western edge", () => {
    expect(longitudeRanges(-179.5, 1)).toEqual([
      { gte: 179.5, lte: 180 },
      { gte: -180, lte: -178.5 },
    ]);
  });

  it("covers the whole circle when the delta exceeds half the globe", () => {
    expect(longitudeRanges(0, 180)).toEqual([{ gte: -180, lte: 180 }]);
  });

  it("never returns an interval that runs backwards", () => {
    for (const centre of [-179.9, -179, -90, 0, 90, 179, 179.9]) {
      for (const delta of [0.1, 1, 45, 90, 179, 180]) {
        for (const range of longitudeRanges(centre, delta)) {
          expect(range.gte).toBeLessThanOrEqual(range.lte);
          expect(range.gte).toBeGreaterThanOrEqual(-180);
          expect(range.lte).toBeLessThanOrEqual(180);
        }
      }
    }
  });
});
