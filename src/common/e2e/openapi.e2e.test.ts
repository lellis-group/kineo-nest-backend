/**
 * The OpenAPI document, read back through HTTP.
 *
 * Swagger is only mounted outside a hardened environment — development and test
 * are exactly where the frontend reads it — and generating the document walks
 * every registered response schema. A `z.date()` anywhere used to stop the whole
 * generator (`Date cannot be represented in JSON Schema`), so the two endpoints
 * answered with the router's error and not a word about the schema at fault.
 * Only the wired document proves the schemas still compile on the wire.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import request from "supertest";
import { bootApp, type E2EFixture, shutdownApp } from "./harness";

let fx: E2EFixture;

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

describe("the OpenAPI document", () => {
  it("generates and serves the JSON document", async () => {
    const response = await request(fx.baseUrl).get("/api-json");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      openapi: expect.any(String),
      info: { title: expect.any(String) },
      paths: expect.any(Object),
    });
  });

  it("serves the interactive UI", async () => {
    const response = await request(fx.baseUrl).get("/api");

    expect(response.status).toBe(200);
    expect(response.text).toContain("swagger");
  });

  it("declares the upload fields as binary so Swagger UI shows a file picker", async () => {
    // @ApiConsumes alone leaves requestBody empty and the UI silently renders
    // no file input at all. Only `format: binary` makes it build a FormData.
    const response = await request(fx.baseUrl).get("/api-json");
    interface BinaryBodyPath {
      post?: {
        requestBody?: {
          content?: Record<
            string,
            { schema?: { properties?: Record<string, unknown> } }
          >;
        };
      };
    }
    const paths = response.body.paths as Record<string, BinaryBodyPath>;

    expect(
      paths["/files/avatar"]?.post?.requestBody?.content?.[
        "multipart/form-data"
      ]?.schema?.properties?.file,
    ).toEqual({ type: "string", format: "binary" });
    expect(
      paths["/files/listings/{listingId}/images"]?.post?.requestBody?.content?.[
        "multipart/form-data"
      ]?.schema?.properties?.images,
    ).toEqual({
      type: "array",
      items: { type: "string", format: "binary" },
    });
  });

  it("declares bearer auth on protected routes and leaves anonymous ones open", async () => {
    const response = await request(fx.baseUrl).get("/api-json");
    const document = response.body;

    expect(document.components.securitySchemes).toMatchObject({
      bearer: { type: "http", scheme: "bearer" },
    });
    expect(document.paths["/files/avatar"]?.post?.security).toEqual([
      { bearer: [] },
    ]);
    expect(document.paths["/profile/me"]?.get?.security).toEqual([
      { bearer: [] },
    ]);
    // /ping opts out of the global AuthGuard, so the doc must not claim one.
    expect(document.paths["/ping"]?.get?.security).toBeUndefined();
  });

  it("names the routes the frontend reads", async () => {
    // The document walks every registered schema on the way to this answer; a
    // day it refuses, the router answers with an error and no path survives.
    // The response shapes themselves are pinned at the unit level, where the
    // schema is asked to compile directly.
    const response = await request(fx.baseUrl).get("/api-json");

    expect(response.body.paths["/practices/{id}"]?.get?.operationId).toBe(
      "PracticesController_findOne",
    );
    expect(response.body.paths["/profile/{id}"]?.get?.operationId).toBe(
      "ProfileController_findOne",
    );
  });
});
