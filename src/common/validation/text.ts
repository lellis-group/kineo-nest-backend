import { z } from "zod";

/**
 * Control / invisible characters that a legitimate user never types and that
 * can be abused for phishing or spoofing (zero-width characters, bidi
 * overrides), log injection, or to smuggle invisible characters into fields
 * that are otherwise validated as numeric or canonical.
 *
 * Tab (0x09), LF (0x0A) and CR (0x0D) are intentionally kept: multi-line free
 * text (messages, descriptions) may legitimately contain newlines.
 */
export const FORBIDDEN_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

/**
 * City labels may carry a postcode typed by a reader who did not pick a
 * suggestion (`Lyon 69000`), but never markup or punctuation used to smuggle
 * it. Unicode letters and digits cover French accents and the overseas codes.
 */
export const CITY_LABEL_REGEX = /^[\p{L}\p{N}\s'’\-]+$/u;

/**
 * Validate a human-readable text field: trims leading/trailing whitespace,
 * requires between 1 and `maxLength` characters and rejects forbidden
 * control / invisible characters.
 */
export function textField(maxLength: number, fieldLabel: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !FORBIDDEN_CHARS.test(value), {
      message: `${fieldLabel} contains forbidden control or invisible characters`,
    });
}
