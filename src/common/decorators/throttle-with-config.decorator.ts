import { applyDecorators } from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import configuration from "../../config/configuration";

const config = configuration();

export type ThrottleTier = "short" | "medium" | "long" | "deletion";

const TIERS: ThrottleTier[] = ["short", "medium", "long", "deletion"];

/**
 * Custom decorator that applies throttling based on the application configuration.
 * Uses the throttle settings defined in config/configuration.ts which reads from environment variables.
 *
 * The ThrottlerGuard applies ALL configured throttlers to every
 * request. To test a single tier in isolation, this decorator skips the other
 * throttlers for the target route and only applies the requested one.
 *
 * @param throttleName - The name of the throttle tier to apply
 */
export function ThrottleWithConfig(throttleName: ThrottleTier) {
  const throttleConfig = config.throttle[throttleName];

  const skipOthers: Record<ThrottleTier, boolean> = Object.fromEntries(
    TIERS.map((tier) => [tier, tier !== throttleName]),
  ) as Record<ThrottleTier, boolean>;

  return applyDecorators(
    SkipThrottle(skipOthers),
    Throttle({
      [throttleName]: {
        limit: throttleConfig.limit,
        ttl: throttleConfig.ttl,
      },
    }),
  );
}
