import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import {
  decodeVerificationToken,
  isChangeEmailToken,
  verificationTarget,
} from "./verification-token";

/**
 * Better Auth plugin exposing `GET /api/auth/check-email-verification`.
 *
 * Reports whether the intent of an email verification link (even an expired or
 * already-used one) has been fulfilled, so the frontend `/verify-email` page can
 * show success instead of an error in that case.
 *
 * "The intent", not "the account": on a change of address the token carries the
 * *current* address in `email` and the new one in `updateTo`, so resolving on
 * `email` answered with the state of an account the link was not about — and
 * since that account is verified whenever the change flow runs, it reported a
 * success for a change that had not been applied.
 *
 * Security: the signature is verified with `BETTER_AUTH_SECRET` (only
 * expiration is ignored), so the status is only revealed to holders of a
 * token this server issued.
 */
export function emailVerificationStatusPlugin(): BetterAuthPlugin {
  return {
    id: "email-verification-status",
    endpoints: {
      checkEmailVerificationStatus: createAuthEndpoint(
        "/check-email-verification",
        {
          method: "GET",
          query: z.object({
            token: z.string().min(1),
          }),
        },
        async (ctx) => {
          const decoded = await decodeVerificationToken(
            ctx.query.token,
            ctx.context.secret,
          );

          if (!decoded) {
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid token",
            });
          }

          // On a change, the flow is complete once the new address belongs to
          // the account and is verified. Until then nobody owns it, and the page
          // must offer to start over rather than claim a success.
          const target = verificationTarget(decoded);
          const record =
            await ctx.context.internalAdapter.findUserByEmail(target);

          const fulfilled = isChangeEmailToken(decoded)
            ? record !== null && record.user.emailVerified === true
            : record?.user.emailVerified === true;

          return ctx.json({ verified: fulfilled });
        },
      ),
    },
  };
}
