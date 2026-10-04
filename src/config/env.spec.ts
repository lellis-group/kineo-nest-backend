import { describe, expect, it } from "bun:test";
import { isHardenedEnv } from "./env";

describe("isHardenedEnv", () => {
  it("treats development and test as non-hardened", () => {
    expect(isHardenedEnv("development")).toBe(false);
    expect(isHardenedEnv("test")).toBe(false);
  });

  it("treats anything else as hardened", () => {
    expect(isHardenedEnv("production")).toBe(true);
    expect(isHardenedEnv("staging")).toBe(true);
    expect(isHardenedEnv("PRODUCTION")).toBe(true);
    expect(isHardenedEnv("prod ")).toBe(true);
  });

  it("defaults to hardened when the value is missing or blank", () => {
    expect(isHardenedEnv()).toBe(true);
    expect(isHardenedEnv(null)).toBe(true);
    expect(isHardenedEnv("")).toBe(true);
    expect(isHardenedEnv("   ")).toBe(true);
  });
});
