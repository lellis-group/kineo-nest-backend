import { beforeEach, describe, expect, it } from "bun:test";
import { SignJWT } from "jose";
import { createAuth, readAuthEnv } from "./index";

const SECRET = "e".repeat(64);

type Sent = { to?: string; subject?: string; html?: string };

const sent: Sent[] = [];

/** Replaces the transport, so nothing reaches a socket. */
async function captureMail() {
  const { configureMailer } = await import("../email/mailer");
  configureMailer({
    transporter: {
      sendMail: async (message: Sent) => {
        sent.push(message);
        return { messageId: "captured" };
      },
    } as never,
  });
}

function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

function handler() {
  const auth = createAuth(
    readAuthEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
      FRONTEND_URL: "http://localhost:3001",
      NODE_ENV: "test",
      SMTP_HOST: "localhost",
    }),
  );

  const send = auth.options?.emailVerification?.sendVerificationEmail;

  if (!send) {
    throw new Error(
      "emailVerification.sendVerificationEmail is not configured",
    );
  }

  return send;
}

beforeEach(async () => {
  sent.length = 0;
  await captureMail();
});

describe("sendVerificationEmail", () => {
  it("sends the sign-up template for a plain verification token", async () => {
    await handler()({
      user: { email: "user@example.com", name: "Alice" } as never,
      url: "http://localhost:3000/api/auth/verify-email?token=t",
      token: await signToken({ email: "user@example.com" }),
    } as never);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user@example.com");
    expect(sent[0].subject).toBe("Verify your email address");
  });

  it("sends the change-email template, not the sign-up one, on an address change", async () => {
    const token = await signToken({
      email: "old@example.com",
      updateTo: "new@example.com",
      requestType: "change-email-verification",
    });

    await handler()({
      user: { email: "new@example.com", name: "Alice" } as never,
      url: `http://localhost:3000/api/auth/verify-email?token=${token}`,
      token,
    } as never);

    // Two messages, two addresses, two jobs: the new one carries the link, the
    // old one is told. Neither is the sign-up template.
    expect(sent.map((mail) => mail.subject)).toEqual([
      "Confirm your new email address",
      "Your email address is being changed",
    ]);
    expect(
      sent.every((mail) => mail.subject !== "Verify your email address"),
    ).toBe(true);

    const toNew = sent.find((mail) => mail.to === "new@example.com");
    expect(toNew?.subject).toBe("Confirm your new email address");
    expect(toNew?.html).toContain("flow=change-email");
  });

  it("tells the frontend which flow the link belongs to", async () => {
    const token = await signToken({
      email: "old@example.com",
      updateTo: "new@example.com",
      requestType: "change-email-verification",
    });

    await handler()({
      user: { email: "new@example.com", name: "Alice" } as never,
      url: `http://localhost:3000/api/auth/verify-email?token=${token}`,
      token,
    } as never);

    const html = sent.find((mail) => mail.to === "new@example.com")?.html ?? "";
    expect(html).toContain("flow=change-email");
    expect(html).toContain("new%40example.com");
  });

  it("warns the address being replaced, without a button to press", async () => {
    const token = await signToken({
      email: "old@example.com",
      updateTo: "new@example.com",
      requestType: "change-email-verification",
    });

    await handler()({
      user: { email: "new@example.com", name: "Alice", id: "user-1" } as never,
      url: `http://localhost:3000/api/auth/verify-email?token=${token}`,
      token,
    } as never);

    const toOld = sent.find((mail) => mail.to === "old@example.com");
    expect(toOld?.subject).toBe("Your email address is being changed");
    expect(toOld?.subject).not.toBe("Verify your email address");
    expect(toOld?.html).toContain("new@example.com");
    expect(toOld?.html).not.toContain("flow=change-email");
  });

  it("does not warn an address when the change does not come from one", async () => {
    await handler()({
      user: { email: "user@example.com", name: "Alice", id: "user-1" } as never,
      url: "http://localhost:3000/api/auth/verify-email?token=t",
      token: await signToken({ email: "user@example.com" }),
    } as never);

    expect(sent).toHaveLength(1);
  });

  it("falls back to the sign-up template when the token cannot be read", async () => {
    await handler()({
      user: { email: "user@example.com", name: "Alice" } as never,
      url: "http://localhost:3000/api/auth/verify-email?token=garbage",
      token: "garbage",
    } as never);

    expect(sent[0].subject).toBe("Verify your email address");
  });
});
