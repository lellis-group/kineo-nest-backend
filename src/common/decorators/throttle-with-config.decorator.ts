import { applyDecorators } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

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
 * No `@Throttle()` is applied, and that is the whole point.
 *
 * `ThrottlerGuard.canActivate` resolves each tier as
 * `routeOrClassLimit || namedThrottler.limit`
 * (`@nestjs/throttler/dist/throttler.guard.js`), so a `@Throttle()` here would
 * OVERRIDE whatever `ThrottlerModule.forRootAsync` read from the validated
 * config. The decorator used to re-read `configuration()` at module scope to
 * supply those numbers — a second source of truth, frozen at import time and
 * never checked against the Zod schema in `configuration.ts`. An invalid
 * `THROTTLE_MEDIUM_LIMIT` would then throw while the decorator file was being
 * loaded, before the app had a chance to report a proper boot error.
 *
 * Skipping the other tiers is enough: the requested one keeps running with the
 * limit and window `AppModule` configured, which come from `ConfigService`
 * after validation. One source of truth, and an invalid value is reported once,
 * at boot, with a message naming the variable.
 *
 * @param throttleName - The name of the throttle tier to apply
 */
export function ThrottleWithConfig(throttleName: ThrottleTier) {
  const skipOthers: Record<ThrottleTier, boolean> = Object.fromEntries(
    TIERS.map((tier) => [tier, tier !== throttleName]),
  ) as Record<ThrottleTier, boolean>;

  return applyDecorators(SkipThrottle(skipOthers));
}
