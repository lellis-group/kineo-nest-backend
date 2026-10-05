import { describe, expect, it } from "bun:test";
import { SignJWT } from "jose";
import { decodeVerificationToken } from "./verification-token";

const SECRET = "unit-test-secret";

function signToken(
  payload: Record<string, unknown>,
  options: { expiresIn?: number; secret?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt();

  if (options.expiresIn !== undefined) {
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn);
  }

  return jwt.sign(new TextEncoder().encode(options.secret ?? SECRET));
}

describe("decodeVerificationToken", () => {
  it("decodes a valid verification token", async () => {
    const token = await signToken(
      { email: "user@example.com" },
      { expiresIn: 3600 },
    );

    expect(await decodeVerificationToken(token, SECRET)).toEqual({
      email: "user@example.com",
    });
  });

  it("decodes a change-email token with the address it moves to", async () => {
    const token = await signToken(
      {
        email: "old@example.com",
        updateTo: "new@example.com",
        requestType: "change-email-verification",
      },
      { expiresIn: 3600 },
    );

    expect(await decodeVerificationToken(token, SECRET)).toEqual({
      email: "old@example.com",
      updateTo: "new@example.com",
      requestType: "change-email-verification",
    });
  });

  it("ignores an unknown requestType rather than trusting it", async () => {
    const token = await signToken(
      { email: "user@example.com", requestType: "something-else" },
      { expiresIn: 3600 },
    );

    expect(await decodeVerificationToken(token, SECRET)).toEqual({
      email: "user@example.com",
    });
  });

  it("decodes an expired token because only the signature matters here", async () => {
    const token = await signToken(
      { email: "user@example.com" },
      { expiresIn: -60 },
    );

    expect(await decodeVerificationToken(token, SECRET)).toEqual({
      email: "user@example.com",
    });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signToken(
      { email: "user@example.com" },
      { expiresIn: 3600, secret: "other-secret" },
    );

    expect(await decodeVerificationToken(token, SECRET)).toBeNull();
  });

  it("rejects a payload without an email", async () => {
    const token = await signToken({ foo: "bar" }, { expiresIn: 3600 });

    expect(await decodeVerificationToken(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await decodeVerificationToken("not-a-jwt", SECRET)).toBeNull();
  });
});
