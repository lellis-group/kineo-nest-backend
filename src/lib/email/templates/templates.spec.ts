import { describe, expect, it } from "bun:test";
import { notificationEmailTemplate } from "./notification";
import { resetPasswordEmailTemplate } from "./reset-password";
import { verificationEmailTemplate } from "./verification";

const XSS = '<img src=x onerror="alert(1)">';

describe("email templates", () => {
  it("escapes injected markup in every interpolated field", () => {
    const html = notificationEmailTemplate({
      name: XSS,
      title: XSS,
      message: XSS,
      ctaLabel: XSS,
      url: "https://app.kineo.test/goodbye",
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
  });

  it("renders a javascript url as no call to action at all", () => {
    const html = notificationEmailTemplate({
      title: "Test",
      message: "Test",
      ctaLabel: "Click me",
      url: "javascript:alert(document.cookie)",
    });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Click me");
  });

  it("escapes the name in the verification and reset templates", () => {
    const verification = verificationEmailTemplate({
      name: XSS,
      url: "https://app.kineo.test/verify-email?token=abc",
    });
    const reset = resetPasswordEmailTemplate({
      name: XSS,
      url: "https://app.kineo.test/reset-password?token=abc",
    });

    expect(verification).not.toContain("<img");
    expect(reset).not.toContain("<img");
    expect(verification).toContain("https://app.kineo.test/verify-email");
    expect(reset).toContain("https://app.kineo.test/reset-password");
  });

  it("keeps legitimate links intact", () => {
    const html = notificationEmailTemplate({
      title: "Suppression de votre compte",
      message: "Bonjour,\nceci est un test.",
      ctaLabel: "Supprimer mon compte",
      url: "https://app.kineo.test/goodbye?token=abc123",
    });

    expect(html).toContain(
      'href="https://app.kineo.test/goodbye?token=abc123"',
    );
    expect(html).toContain("Supprimer mon compte");
  });
});
