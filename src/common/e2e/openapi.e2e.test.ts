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
