import { applyDecorators } from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { THROTTLE_NAMES, type ThrottleName, throttleTier } from "../throttle";

/**
 * Applies one configured tier to a route and skips the others.
 *
 * ThrottlerGuard applies every registered throttler to every request, so
 * testing a single tier in isolation means skipping the rest.
 */
export function ThrottleWithConfig(throttleName: ThrottleName) {
  const { limit, ttl } = throttleTier(throttleName);

  const skipOthers = Object.fromEntries(
    THROTTLE_NAMES.filter((name) => name !== throttleName).map((name) => [
      name,
      true,
    ]),
  );

  return applyDecorators(
    SkipThrottle(skipOthers),
    Throttle({ [throttleName]: { limit, ttl } }),
  );
}
