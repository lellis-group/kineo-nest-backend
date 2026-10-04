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

  describe("notice callout", () => {
    it("renders the notice and its own action link", () => {
      const html = notificationEmailTemplate({
        title: "Suppression de votre compte",
        message: "Message principal",
        ctaLabel: "Supprimer mon compte",
        url: "https://app.kineo.test/goodbye?token=abc",
        notice: {
          title: "Les candidatures de vos candidats seront conservées (3)",
          body: "3 candidatures d'autres candidats reposent sur vos annonces.",
          actionUrl: "https://app.kineo.test/mes-annonces",
          actionLabel: "Relire mes annonces avant de confirmer",
        },
      });

      expect(html).toContain(
        "Les candidatures de vos candidats seront conservées",
      );
      expect(html).toContain("3 candidatures d");
      expect(html).toContain('href="https://app.kineo.test/mes-annonces"');
      expect(html).toContain("Relire mes annonces avant de confirmer");
      // The main call to action is preserved alongside the notice.
      expect(html).toContain('href="https://app.kineo.test/goodbye?token=abc"');
    });

    it("escapes the notice content", () => {
      const html = notificationEmailTemplate({
        title: "Test",
        message: "Test",
        notice: { title: XSS, body: XSS, actionLabel: XSS },
      });

      expect(html).not.toContain("<img");
      expect(html).not.toContain('onerror="');
    });

    it("drops a javascript notice action", () => {
      const html = notificationEmailTemplate({
        title: "Test",
        message: "Test",
        notice: {
          title: "Alerte",
          body: "Corps",
          actionUrl: "javascript:alert(1)",
          actionLabel: "Ne pas cliquer",
        },
      });

      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("Ne pas cliquer");
    });

    it("renders no callout at all when there is no notice", () => {
      const html = notificationEmailTemplate({
        title: "Test",
        message: "Test",
      });

      expect(html).not.toContain("seront conservées");
    });
  });

  describe("a rejected link URL", () => {
    // `safeUrl` returns undefined for a scheme it does not allow, so an
    // unconditional interpolation renders href="undefined": a button that looks
    // live and goes nowhere. Unreachable from the auth layer, whose URLs are all
    // built from a validated FRONTEND_URL, which makes it a silent dead
    // account-recovery link rather than an attack.
    const REJECTED = "javascript:alert(1)";

    it("omits the anchor in the verification template", () => {
      const html = verificationEmailTemplate({
        url: REJECTED,
      });

      expect(html).not.toContain("href=");
      expect(html).not.toContain("undefined");
    });

    it("omits the anchor in the reset-password template", () => {
      const html = resetPasswordEmailTemplate({
        url: REJECTED,
      });

      expect(html).not.toContain("href=");
      expect(html).not.toContain("undefined");
    });

    it("omits the anchor in the notification template", () => {
      const html = notificationEmailTemplate({
        title: "Test",
        message: "Test",
        ctaLabel: "Confirmer",
        url: REJECTED,
      });

      expect(html).not.toContain("href=");
      expect(html).not.toContain("undefined");
    });

    it("still renders the anchor for an allowed URL", () => {
      expect(
        verificationEmailTemplate({ url: "https://app.kineo.test/verify" }),
      ).toContain('href="https://app.kineo.test/verify"');
    });
  });
});
