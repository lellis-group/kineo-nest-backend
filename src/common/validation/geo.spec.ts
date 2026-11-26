import { describe, expect, it } from "bun:test";
import {
  CITY_CODE_REGEX,
  DEPARTMENT_CODE_REGEX,
  departmentCodeFromCityCode,
  geoCodesAgree,
  POSTAL_CODE_REGEX,
} from "./geo";

describe("departmentCodeFromCityCode", () => {
  it("uses the first two digits on the mainland and in the DOM", () => {
    expect(departmentCodeFromCityCode("75056")).toBe("75");
    expect(departmentCodeFromCityCode("69001")).toBe("69");
  });

  it("keeps the lettered Corsican departments and the three-digit overseas ones", () => {
    expect(departmentCodeFromCityCode("2A004")).toBe("2A");
    expect(departmentCodeFromCityCode("2B005")).toBe("2B");
    expect(departmentCodeFromCityCode("97100")).toBe("971");
  });
});

describe("geoCodesAgree", () => {
  it("accepts a lone code, or a matching pair", () => {
    expect(geoCodesAgree({ cityCodeInsee: "75056" })).toBe(true);
    expect(geoCodesAgree({ departmentCode: "75" })).toBe(true);
    expect(
      geoCodesAgree({ cityCodeInsee: "75056", departmentCode: "75" }),
    ).toBe(true);
  });

  it("refuses a pair that contradicts itself", () => {
    expect(
      geoCodesAgree({ cityCodeInsee: "75056", departmentCode: "69" }),
    ).toBe(false);
  });
});

describe("geo code formats", () => {
  it("accepts the canonical shapes", () => {
    expect(CITY_CODE_REGEX.test("75056")).toBe(true);
    expect(CITY_CODE_REGEX.test("2A004")).toBe(true);
    expect(DEPARTMENT_CODE_REGEX.test("2A")).toBe(true);
    expect(DEPARTMENT_CODE_REGEX.test("971")).toBe(true);
    expect(POSTAL_CODE_REGEX.test("75001")).toBe(true);
  });

  it("refuses injection-shaped values", () => {
    expect(CITY_CODE_REGEX.test("75056' OR 1=1")).toBe(false);
    expect(DEPARTMENT_CODE_REGEX.test("69; DROP")).toBe(false);
  });
});
