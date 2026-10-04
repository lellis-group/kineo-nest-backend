import { compactVerify } from "jose";

/**
 * What a verification link is for.
 *
 * `CHANGE_EMAIL` tokens carry `updateTo` and apply the address change when the
 * link is opened. A plain sign-up token carries neither, and the link only marks
 * the address verified.
 */
export type VerificationRequestType =
  | "change-email-verification"
  | "change-email-confirmation";

export interface VerificationTokenPayload {
  /** The address the token was issued for. On a change, the *current* one. */
  email: string;
  /** The address being moved to, on a change. Absent on a sign-up. */
  updateTo?: string;
  requestType?: VerificationRequestType;
}

export function isChangeEmailToken(payload: VerificationTokenPayload): boolean {
  return payload.requestType?.startsWith("change-email") === true;
}

/**
 * The address the link's intent concerns: the one being moved to on a change,
 * the token's own address otherwise.
 *
 * `check-email-verification` used the token's `email` on its own, which on a
 * change is the *old* address — so it answered with the state of an account the
 * link was not about, and could report a success that never happened.
 */
export function verificationTarget(payload: VerificationTokenPayload): string {
  return isChangeEmailToken(payload) && payload.updateTo
    ? payload.updateTo
    : payload.email;
}

/**
 * Decodes a Better Auth verification token (HS256 JWT signed with
 * `BETTER_AUTH_SECRET`), intentionally ignoring expiration: `compactVerify`
 * only checks the JWS signature, and only this server can have produced it.
 * Used to know which account a verification link points to — and which flow it
 * belongs to — even when the token is expired or already consumed.
 *
 * Returns `null` on invalid signature, format or payload.
 */
export async function decodeVerificationToken(
  token: string,
  secret: string,
): Promise<VerificationTokenPayload | null> {
  try {
    const { payload } = await compactVerify(
      token,
      new TextEncoder().encode(secret),
    );

    const claims = JSON.parse(new TextDecoder().decode(payload)) as {
      email?: unknown;
      updateTo?: unknown;
      requestType?: unknown;
    };

    const { email, updateTo, requestType } = claims;

    if (typeof email !== "string" || email.length === 0) {
      return null;
    }

    const decoded: VerificationTokenPayload = { email };

    if (typeof updateTo === "string" && updateTo.length > 0) {
      decoded.updateTo = updateTo;
    }

    if (
      requestType === "change-email-verification" ||
      requestType === "change-email-confirmation"
    ) {
      decoded.requestType = requestType;
    }

    return decoded;
  } catch {
    return null;
  }
}
