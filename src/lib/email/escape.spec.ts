import { describe, expect, it } from "bun:test";
import { escapeHtml, safeUrl } from "./escape";
import { notificationEmailTemplate } from "./templates/notification";
import { resetPasswordEmailTemplate } from "./templates/reset-password";
import { verificationEmailTemplate } from "./templates/verification";

describe("escapeHtml", () => {
  it("escapes every character that can break out of HTML text or an attribute", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  it("leaves a plain string untouched", () => {
    expect(escapeHtml("Kinéo — replacement")).toBe("Kinéo — replacement");
  });
});

describe("safeUrl", () => {
  it("accepts http and https", () => {
    expect(safeUrl("https://app.example.com/reset?token=abc")).toBe(
      "https://app.example.com/reset?token=abc",
    );
    expect(safeUrl("http://localhost:3001/x")).toBe("http://localhost:3001/x");
  });

  it("rejects any other scheme", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeUrl("vbscript:msgbox(1)")).toBeUndefined();
  });

  it("returns undefined for a missing url", () => {
    expect(safeUrl(undefined)).toBeUndefined();
    expect(safeUrl("")).toBeUndefined();
  });

  it("escapes the accepted url", () => {
    expect(safeUrl('https://example.com/?q="x"')).toBe(
      "https://example.com/?q=&quot;x&quot;",
    );
  });
});

describe("email templates", () => {
  it("renders a user-supplied name as text, not markup", () => {
    const html = notificationEmailTemplate({
      name: "<img src=x onerror=alert(1)>",
      title: "Notification",
      message: "Bonjour",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders a free-text message as text and turns newlines into breaks", () => {
    const html = notificationEmailTemplate({
      title: "Notification",
      message: "ligne 1\n<script>alert(1)</script>",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("ligne 1<br>");
  });

  it("drops the call to action when the url is not http(s)", () => {
    const html = notificationEmailTemplate({
      title: "Notification",
      message: "Bonjour",
      url: "javascript:alert(1)",
      ctaLabel: "Confirmer",
    });

    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("Confirmer");
  });

  it("keeps the call to action for an http(s) url", () => {
    const html = notificationEmailTemplate({
      title: "Notification",
      message: "Bonjour",
      url: "https://app.example.com/confirm?token=abc",
      ctaLabel: "Confirmer",
    });

    expect(html).toContain('href="https://app.example.com/confirm?token=abc"');
    expect(html).toContain("Confirmer");
  });

  it("escapes the name and the link in the verification and reset templates", () => {
    const verification = verificationEmailTemplate({
      name: "<b>eve</b>",
      url: "https://app.example.com/verify?token=abc",
    });
    const reset = resetPasswordEmailTemplate({
      name: "<b>eve</b>",
      url: "https://app.example.com/reset?token=abc",
    });

    for (const html of [verification, reset]) {
      expect(html).not.toContain("<b>eve</b>");
      expect(html).toContain("&lt;b&gt;eve&lt;/b&gt;");
      expect(html).toContain('href="https://app.example.com/');
    }
  });
});
