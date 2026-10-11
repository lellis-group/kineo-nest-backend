/**
 * The request body ceiling, over HTTP.
 *
 * Nest's own body parser is off and this module mounts the parsers instead, so
 * the limit is a library default unless the repository states it. A body above it
 * has to be refused before it is read, not after.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import request from "supertest";
import {
  bootApp,
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
  signIn,
} from "./harness";

const PASSWORD = "Password123!";

let fx: E2EFixture;

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

describe("a body above the limit", () => {
  it("is refused with 413, whatever it would have failed on", async () => {
    await resetData(fx.prisma);

    const user = await createVerifiedUser(
      fx.prisma,
      "user-body",
      "body@test.invalid",
      PASSWORD,
    );
    const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .post("/practices")
      .set("Cookie", cookies)
      .set("content-type", "application/json")
      .send({ description: "a".repeat(200_000) });

    expect(response.status).toBe(413);
  });
});
