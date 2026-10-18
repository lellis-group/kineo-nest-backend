/**
 * The one place a failure stops being invisible.
 *
 * Every mail in this application goes through `sendEmail`, and the path that
 * matters most is the one where the server refuses: the mail is not sent, the
 * caller gets the error, and a single line goes to the log saying which event
 * failed. None of that was tested — `lib/email/mailer.ts` sat at 62 % — which
 * means the two questions that matter during an incident, « did the mail go
 * out » and « why not », were both answered by guessing.
 *
 * The SMTP configuration is resolved here too, and it is where a deployment
 * mistake turns into silence: a `SMTP_PORT` that is not a number becomes `NaN`
 * rather than the default, and a client connecting to a `NaN` port does nothing
 * at all.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { configureMailer, resolveSmtpConfig, sendEmail } from "./mailer";

/** The local development server, as `mailer.ts` defines it internally. */
const DEFAULT_SMTP = {
  host: "localhost",
  port: 1025,
  secure: false,
  from: "noreply@localhost",
};

/**
 * Collects `console.error` for the duration of `run`, and gives it back after.
 *
 * The failure is swallowed: what these tests read is the log line the failure
 * produced, and the error itself is asserted separately with `rejects`.
 */
async function captureErrors(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await run().catch(() => undefined);
    return lines;
  } finally {
    console.error = original;
  }
}

/** A transport that records what it was handed, and optionally fails. */
function fakeTransport(failure?: Error) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    transporter: {
      sendMail: async (message: Record<string, unknown>) => {
        sent.push(message);
        if (failure) {
          throw failure;
        }
        return { messageId: "fake" };
      },
    } as never,
  };
}

afterEach(() => {
  // A fake left in place would make the next suite believe it had a transport.
  configureMailer(undefined);
});

describe("resolveSmtpConfig", () => {
  it("falls back to the local development server when nothing is configured", () => {
    expect(resolveSmtpConfig({})).toEqual(DEFAULT_SMTP);
  });

  it("reads every value from the environment", () => {
    const config = resolveSmtpConfig({
      SMTP_HOST: "smtp.example.org",
      SMTP_PORT: "587",
      SMTP_SECURE: "true",
      SMTP_FROM: "hello@example.org",
      SMTP_USER: "postmaster",
      SMTP_PASS: "secret",
    });

    expect(config).toEqual({
      host: "smtp.example.org",
      port: 587,
      secure: true,
      from: "hello@example.org",
      user: "postmaster",
      pass: "secret",
    });
  });

  /**
   * A port that is not a port.
   *
   * `Number("not-a-port")` is `NaN`, and a client handed `NaN` does not fall
   * back to anything — it fails at connect time, or worse, resolves to port 0.
   * This is the difference between a deployment that starts and one that never
   * sends a mail again.
   */
  it("falls back to the default port rather than passing on a NaN", () => {
    expect(resolveSmtpConfig({ SMTP_PORT: "not-a-port" }).port).toBe(
      DEFAULT_SMTP.port,
    );
    expect(resolveSmtpConfig({ SMTP_PORT: "0" }).port).toBe(DEFAULT_SMTP.port);
    expect(resolveSmtpConfig({ SMTP_PORT: "-25" }).port).toBe(
      DEFAULT_SMTP.port,
    );
  });

  it('treats any secure value other than "true" as insecure', () => {
    // One misspelled variable silently downgrading a TLS connection is the kind
    // of bug nobody reports, because mail still arrives — until it doesn't.
    expect(resolveSmtpConfig({ SMTP_SECURE: "yes" }).secure).toBe(false);
    expect(resolveSmtpConfig({ SMTP_SECURE: "TRUE" }).secure).toBe(false);
    expect(resolveSmtpConfig({ SMTP_SECURE: "1" }).secure).toBe(false);
  });
});

describe("sendEmail", () => {
  it("sends through the transport it was given, without a socket", async () => {
    const fake = fakeTransport();
    configureMailer({ from: "noreply@test", transporter: fake.transporter });

    await sendEmail({
      to: "reader@test",
      subject: "Hello",
      html: "<p>Hello</p>",
    });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      from: "noreply@test",
      to: "reader@test",
      subject: "Hello",
      html: "<p>Hello</p>",
    });
  });

  /**
   * The failure path, which is the whole reason this file exists.
   *
   * Two properties at once, and both are the point: the error reaches the
   * caller instead of being swallowed — a swallowed error is a signup that
   * reports success and never receives a link — and the log line says which
   * event failed.
   */
  it("rethrows the failure, after logging which event failed", async () => {
    const failure = new Error("550 mailbox unavailable");
    configureMailer({
      transporter: fakeTransport(failure).transporter,
    });

    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await expect(
        sendEmail({ to: "reader@test", subject: "Hello", html: "<p>Hi</p>" }),
      ).rejects.toBe(failure);
    } finally {
      console.error = original;
    }

    // A swallowed error here is a signup that reports success and never
    // receives its link, so the throw is the assertion, not a detail.
    expect(lines.some((line) => line.includes("email.send_failed"))).toBe(true);
  });

  it("logs the recipient's domain and never the address itself", async () => {
    configureMailer({
      transporter: fakeTransport(new Error("connection refused")).transporter,
    });

    const lines = await captureErrors(() =>
      sendEmail({
        to: "camille.dupont@example.org",
        subject: "Hello",
        html: "<p>Hi</p>",
      }),
    );

    const logged = lines.find((line) => line.includes("email.send_failed"));
    expect(logged).toBeDefined();
    // The domain is enough to tell a sender-side failure from a recipient-side
    // one; the address would put a reader's mailbox into the log.
    expect(logged).toContain("example.org");
    expect(logged).not.toContain("camille.dupont");
  });

  it("goes back to the environment once the override is cleared", async () => {
    configureMailer({
      from: "noreply@test",
      transporter: fakeTransport().transporter,
    });
    expect(resolveSmtpConfig({}).from).toBe("noreply@test");

    configureMailer(undefined);

    // Otherwise one test's fake transport would outlive it, and the suite after
    // would pass against a mailer nothing was ever sent through.
    expect(resolveSmtpConfig({}).from).toBe(DEFAULT_SMTP.from);
  });
});
