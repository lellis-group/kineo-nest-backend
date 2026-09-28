import { describe, expect, it } from "bun:test";
import { isHardenedEnv } from "./env";

describe("isHardenedEnv", () => {
  it("treats development and test as non-hardened", () => {
    expect(isHardenedEnv("development")).toBe(false);
    expect(isHardenedEnv("test")).toBe(false);
  });

  it("treats production and provision as hardened", () => {
    expect(isHardenedEnv("production")).toBe(true);
    expect(isHardenedEnv("provision")).toBe(true);
  });

  it("defaults to hardened for missing or unknown values", () => {
    expect(isHardenedEnv(undefined)).toBe(true);
    expect(isHardenedEnv(null)).toBe(true);
    expect(isHardenedEnv("")).toBe(true);
    expect(isHardenedEnv("staging")).toBe(true);
    expect(isHardenedEnv("Production")).toBe(true);
    expect(isHardenedEnv("DEVELOPMENT")).toBe(false);
  });
});
