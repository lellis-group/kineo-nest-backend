import { describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { FileRules } from "./file-rules";

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, fallback: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe("FileRules", () => {
  const rules = new FileRules(
    config({
      "files.limits.avatarBytes": 1024,
      "files.limits.imageBytes": 2048,
      "files.limits.imagesPerListing": 3,
      "files.limits.cvBytes": 4096,
    }),
  );

  it("reads every ceiling from configuration", () => {
    expect(rules.for("AVATAR").maxBytes).toBe(1024);
    expect(rules.for("LISTING_IMAGE").maxCount).toBe(3);
    expect(rules.for("CV").maxBytes).toBe(4096);
    expect(rules.limitsFor("LISTING_IMAGE")).toEqual({
      fileSize: 2048,
      files: 3,
    });
  });

  it("describes the types the storage engine must detect", () => {
    expect(rules.for("AVATAR").contentTypes).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(rules.for("CV").contentTypes).toEqual(["application/pdf"]);
  });

  it("strips path, control characters and quotes from a display name", () => {
    expect(rules.displayName('../evil\r\n"name".png')).toBe("evilname.png");
    expect(rules.displayName("../../")).toBe("file");
  });
});
