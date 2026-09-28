import { describe, expect, it } from "bun:test";
import { escapeHtml, safeUrl } from "./escape";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;",
    );
  });

  it("escapes ampersands before other entities", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Dr. Léa Dupont")).toBe("Dr. Léa Dupont");
  });
});

describe("safeUrl", () => {
  it("accepts http and https urls", () => {
    expect(safeUrl("https://app.kineo.test/verify?token=abc")).toBe(
      "https://app.kineo.test/verify?token=abc",
    );
    expect(safeUrl("http://localhost:3001/verify")).toBe(
      "http://localhost:3001/verify",
    );
  });

  it("rejects javascript and data schemes", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  });

  it("rejects missing values", () => {
    expect(safeUrl(undefined)).toBeUndefined();
    expect(safeUrl("")).toBeUndefined();
  });

  it("escapes quotes that would break out of the attribute", () => {
    expect(safeUrl('https://a.test/"onmouseover="x')).toContain("&quot;");
  });
});
