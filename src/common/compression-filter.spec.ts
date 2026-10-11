import { describe, expect, it } from "bun:test";
import compression from "compression";
import type { Request, Response } from "express";
import { compressionFilter } from "./compression-filter";

/** The two headers the filter reads, on the shape Express hands it. */
function response(statusCode: number, contentType?: string): Response {
  return {
    statusCode,
    getHeader: (name: string) =>
      name.toLowerCase() === "content-type" ? contentType : undefined,
  } as unknown as Response;
}

const request = {} as Request;

describe("compressionFilter", () => {
  it("leaves a JSON error body uncompressed", () => {
    expect(compressionFilter(request, response(400, "application/json"))).toBe(
      false,
    );
    expect(
      compressionFilter(
        request,
        response(404, "application/json; charset=utf-8"),
      ),
    ).toBe(false);
    expect(compressionFilter(request, response(503, "application/json"))).toBe(
      false,
    );
  });

  it("keeps compressing a successful answer", () => {
    expect(compressionFilter(request, response(200, "application/json"))).toBe(
      true,
    );
  });

  it("keeps the library's decision for anything that is not JSON", () => {
    expect(compressionFilter(request, response(400, "text/html"))).toBe(
      compression.filter(request, response(400, "text/html")),
    );
    expect(compressionFilter(request, response(500))).toBe(
      compression.filter(request, response(500)),
    );
  });
});
