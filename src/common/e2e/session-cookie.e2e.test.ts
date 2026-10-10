/**
 * The session cookie, as it actually goes out.
 *
 * better-auth sets its attributes itself — HttpOnly and SameSite=Lax always,
 * Secure in a hardened environment — and nothing in this repository declares
 * them. Pinning them turns a change of those defaults into a failing test
 * instead of a silent regression.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Lax and scoped to the whole origin", async () => {
    await resetData(fx.prisma);

    const user = await createVerifiedUser(
      fx.prisma,
      "user-cookie",
      "cookie@test.invalid",
      PASSWORD,
    );

    const setCookie = (
      await signIn(fx.baseUrl, user.email, PASSWORD)
    ).toLowerCase();

    expect(setCookie).toContain("httponly");
    expect(setCookie).toContain("samesite=lax");
    expect(setCookie).toContain("path=/");
  });

  it("carries no Secure flag under NODE_ENV=test", async () => {
    await resetData(fx.prisma);

    const user = await createVerifiedUser(
      fx.prisma,
      "user-cookie-plain",
      "cookie-plain@test.invalid",
      PASSWORD,
    );

    const setCookie = await signIn(fx.baseUrl, user.email, PASSWORD);

    expect(setCookie).not.toContain("Secure");
  });
});
