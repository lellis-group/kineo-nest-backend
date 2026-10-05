import { applyDecorators, SetMetadata } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

/**
 * The throttle tiers the global guard applies to every route.
 *
 * The names live here because both the module that registers them and the
 * decorator that narrows a route to one of them have to agree, and a tier
 * declared in only one of the two is applied to the whole API.
 */
export const THROTTLE_NAMES = ["short", "medium", "long"] as const;

export type ThrottleName = (typeof THROTTLE_NAMES)[number];

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

/**
 * Applies one configured tier to a route and skips the other global ones.
 *
 * The decorator narrows *which* tiers apply; it deliberately does not say how big
 * they are. `@nestjs/throttler` resolves the numbers in this order
 * (`throttler.guard.js:83-84`):
 *
 * ```js
 * const limit = await this.resolveValue(context, routeOrClassLimit || namedThrottler.limit);
 * const ttl   = await this.resolveValue(context, routeOrClassTtl  || namedThrottler.ttl);
 * ```
 *
 * So a `Throttle()` here wins over the tier registered by
 * `ThrottlerModule.forRootAsync`. This decorator used to carry one, with values
 * read by calling `configuration()` — which reads `process.env` and bypasses the
 * validated `ConfigService` — at the moment the controller module was imported.
 * The result was a second, frozen copy of every limit, on every route wearing
 * the decorator: changing `THROTTLE_LONG_TTL` in the environment had no effect on
 * them.
 *
 * The numbers now come from `forRootAsync` and its `ConfigService`, which is the
 * single validated source. `throttle.spec.ts` pins that the decorators set no
 * limit or TTL at all, so this cannot come back unnoticed.
 */
export function ThrottleWithConfig(throttleName: ThrottleName) {
  return applyDecorators(
    SkipThrottle(
      Object.fromEntries(
        THROTTLE_NAMES.filter((name) => name !== throttleName).map((name) => [
          name,
          true,
        ]),
      ),
    ),
  );
}

/**
 * The erasure tier on one route, and the erasure tier off everywhere else.
 *
 * Same reasoning as `ThrottleWithConfig`: this only opts in. The endpoint is
 * anonymous and its token is the only proof of identity, so it gets the erasure
 * budget — a long window with a small allowance — rather than the global
 * one-second tier. The budget itself is the one `forRootAsync` registered.
 */
export function ThrottleDeletion() {
  return applyDecorators(
    SetMetadata(DELETION_THROTTLE_KEY, true),
    SkipThrottle(
      Object.fromEntries(THROTTLE_NAMES.map((name) => [name, true])),
    ),
  );
}
