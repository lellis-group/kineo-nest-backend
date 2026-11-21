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
import { bootApp, type E2EFixture, shutdownApp, signInReader } from "./harness";

let fx: E2EFixture;

const PROTECTED_ROUTES = [
  "/applications/mine",
  "/profile/me",
  "/practices/mine",
  "/replacement-listings/mine",
  // The browse feed and the directories are members-only too: they scope
  // nothing to the caller, but nothing in them is meant for an anonymous one.
  "/replacement-listings",
  "/replacement-listings/facets",
  "/replacement-listings/places",
  "/replacement-listings/page-of",
  "/replacement-listings/any-id",
  "/profile",
  "/profile/any-id",
  "/files/mine",
  "/practices",
  "/practices/any-id",
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

describe("GET file routes that opt out with @OptionalAuth", () => {
  it.each(["/files/any-id", "/files/listings/any-id/images"])(
    "answers 404 for %s instead of 401",
    async (route) => {
      // The guard let the anonymous caller through; the file access policy then
      // finds no readable subject and answers as if the file did not exist.
      const response = await request(fx.baseUrl).get(route);
      expect(response.status).toBe(404);
    },
  );
});

describe("Bearer authentication", () => {
  it("accepts a session token in the Authorization header", async () => {
    // better-auth's `bearer()` plugin turns this header into the session cookie
    // the global AuthGuard reads. This is what Swagger's Authorize uses.
    const cookies = await signInReader(fx, "bearer-reader");
    const token = /better-auth\.session_token=([^;]+)/.exec(cookies)?.[1];
    expect(token).toBeTruthy();

    // /files/mine answers an empty list to a member without a profile, so the
    // status proves the session was resolved rather than the fixture's shape.
    const response = await request(fx.baseUrl)
      .get("/files/mine")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("refuses a token that signs no session", async () => {
    const response = await request(fx.baseUrl)
      .get("/profile/me")
      .set("Authorization", "Bearer not-a-session-token");
    expect(response.status).toBe(401);
  });
});

describe("routes that opted out", () => {
  it("still answer", async () => {
    const ping = await request(fx.baseUrl).get("/ping");
    const health = await request(fx.baseUrl).get("/health");

    expect(ping.status).toBe(200);
    // Liveness only: no uptime, no database state, to anyone who asks.
    expect(health.body).toEqual({ status: "ok" });
  });
});
