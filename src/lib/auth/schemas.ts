import { z } from "zod";

/**
 * Zod schemas for user-controlled better-auth fields, enforced by the
 * `before` hook in `src/lib/auth/input-validation.ts`
 * (see `PATH_FIELD_VALIDATORS`).
 *
 * Better-auth remains the source of truth for email format, password policy
 * on set flows and callbackURL origin trust; these schemas only normalize
 * and bound the raw input where better-auth does not.
 */

/** Display name: Unicode letters, spaces, apostrophes, hyphens only; trimmed. */
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\s'-]+$/u);

/** Profile image URL. HTTPS only: blocks `http:`, `data:`, `javascript:` and relative URLs. */
export const httpsImageUrlSchema = z.url({ protocol: /^https$/ });

/** Plaintext password. Keep in sync with `emailAndPassword.min/maxPasswordLength` in `src/lib/auth/index.ts`. */
export const passwordSchema = z.string().min(8).max(128);

/**
 * Password being verified against an existing account (sign-in,
 * verify-password, change-password, delete-user): length is bounded only, to
 * avoid hashing unbounded input. No strength rule: the stored password may
 * predate the current policy.
 */
export const passwordInputSchema = z.string().max(128);

/** Email input for lookup or change: trimmed and lowercased so stored and queried values stay consistent; bounded per RFC 5321. */
export const emailSchema = z.string().trim().toLowerCase().max(254);

/** Opaque token or identifier: trimmed, non-empty, bounded to keep database lookups cheap. */
export const tokenSchema = z.string().trim().min(1).max(512);

/** Control characters (C0, C1, DEL) are never valid in a URL. */
const URL_FORBIDDEN_CHARS = /[\u0000-\u001F\u007F\u0080-\u009F]/u;

/**
 * Redirect/callback URL: bounded shape only (trimmed, no control characters,
 * max length). Relative paths and absolute URLs are both allowed; origin
 * trust is enforced by better-auth (`trustedOrigins`).
 */
export const callbackUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => !URL_FORBIDDEN_CHARS.test(value));
