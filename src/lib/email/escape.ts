const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

export function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value, "https://placeholder.invalid");
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return escapeHtml(value);
  } catch {
    return undefined;
  }
}
