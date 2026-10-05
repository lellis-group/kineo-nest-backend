import { applyDecorators, SetMetadata } from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import configuration from "../config/configuration";

/**
 * The throttle tiers the global guard applies to every route.
 *
 * The names live here because both the module that registers them and the
 * decorator that narrows a route to one of them have to agree, and a tier
 * declared in only one of the two is applied to the whole API.
 */
export const THROTTLE_NAMES = ["short", "medium", "long"] as const;

export type ThrottleName = (typeof THROTTLE_NAMES)[number];

export interface ThrottleTier {
  ttl: number;
  limit: number;
}

export function throttleTier(name: ThrottleName): ThrottleTier {
  return configuration().throttle[name];
}

/**
 * The erasure tier, and the metadata that opts a route into it.
 *
 * The tier is registered so the guard can apply it, but it carries a `skipIf`
 * that refuses it everywhere except a route decorated with ThrottleDeletion.
 * Without that, registering it would extend its limit to every endpoint in the
 * API — and on the routes that legitimately opt out, the guard's error path
 * would still count them.
 */
export const DELETION_THROTTLE_KEY = "kineo:throttle:deletion";

export function deletionThrottleTier(): ThrottleTier {
  return configuration().throttle.deletion;
}

/**
 * Applies the erasure tier to one route and skips the three global ones.
 *
 * The endpoint is anonymous and the token is the only proof of identity, so it
 * gets a long window with a small budget rather than the global 1-second tier.
 */
/** Applies one configured tier to a route and skips the other global ones. */
export function ThrottleWithConfig(throttleName: ThrottleName) {
  const { limit, ttl } = throttleTier(throttleName);

  return applyDecorators(
    SkipThrottle(
      Object.fromEntries(
        THROTTLE_NAMES.filter((name) => name !== throttleName).map((name) => [
          name,
          true,
        ]),
      ),
    ),
    Throttle({ [throttleName]: { limit, ttl } }),
  );
}

/** Applies the erasure tier to one route and skips the three global ones. */
export function ThrottleDeletion() {
  const { limit, ttl } = deletionThrottleTier();

  return applyDecorators(
    SetMetadata(DELETION_THROTTLE_KEY, true),
    SkipThrottle(
      Object.fromEntries(THROTTLE_NAMES.map((name) => [name, true])),
    ),
    Throttle({ deletion: { limit, ttl } }),
  );
}
