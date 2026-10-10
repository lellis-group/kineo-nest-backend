/**
 * The global authentication guard, over HTTP.
 *
 * better-auth registers that guard for this module, and every route is protected
 * unless it opted out with @AllowAnonymous or @OptionalAuth. That default comes
 * from a community maintained library, and nothing in this repository used to
 * send a request without a cookie, so a change of it would have gone unnoticed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import request from "supertest";
import { bootApp, type E2EFixture, shutdownApp } from "./harness";

let fx: E2EFixture;

const PROTECTED_ROUTES = [
  "/applications/mine",
  "/profile/me",
  "/practices/mine",
  "/replacement-listings/mine",
];

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

describe.each(PROTECTED_ROUTES)("GET %s without a cookie", (route) => {
  it("is refused", async () => {
    const response = await request(fx.baseUrl).get(route);

    expect(response.status).toBe(401);
  });
});

describe("routes that opted out", () => {
  it("still answer", async () => {
    const ping = await request(fx.baseUrl).get("/ping");
    const health = await request(fx.baseUrl).get("/health");
    const practice = await request(fx.baseUrl).get("/practices/missing-id");

    expect(ping.status).toBe(200);
    // Liveness only: no uptime, no database state, to anyone who asks.
    expect(health.body).toEqual({ status: "ok" });
    expect(practice.status).toBe(404);
  });
});
