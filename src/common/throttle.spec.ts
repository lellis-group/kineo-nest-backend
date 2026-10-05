import { describe, expect, it } from "bun:test";
import { Reflector } from "@nestjs/core";
import {
  THROTTLER_LIMIT,
  THROTTLER_SKIP,
  THROTTLER_TTL,
} from "@nestjs/throttler/dist/throttler.constants";
import {
  DELETION_THROTTLE_KEY,
  THROTTLE_NAMES,
  ThrottleDeletion,
  ThrottleWithConfig,
} from "./throttle";

/**
 * A read of what the decorators actually put in the metadata, not of what they
 * were meant to.
 *
 * `@nestjs/throttler` prefixes every key with the tier's name and prefers a
 * route's own `THROTTLER_LIMIT + name` over the tier the module registered
 * (`throttler.guard.js:83-84`), so a decorator that sets a limit silently
 * replaces the validated configuration with whatever it read. Both decorators
 * used to do exactly that, with values read from `process.env` at import time.
 *
 * The decorators are applied to a method, because that is how the controllers use
 * them and because `SkipThrottle` writes to the descriptor's function.
 */
function metadataOn(
  decorator: ReturnType<typeof ThrottleWithConfig>,
): Record<string, unknown> {
  class Target {
    handler(): void {}
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    Target.prototype,
    "handler",
  );
  decorator(Target.prototype, "handler", descriptor as PropertyDescriptor);

  const reflector = new Reflector();
  const target = descriptor?.value as () => void;
  const read = (base: string, name: string) =>
    reflector.get(base + name, target);

  return {
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [
        `limit:${name}`,
        read(THROTTLER_LIMIT, name),
      ]),
    ),
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [`ttl:${name}`, read(THROTTLER_TTL, name)]),
    ),
    ...Object.fromEntries(
      THROTTLE_NAMES.map((name) => [
        `skip:${name}`,
        read(THROTTLER_SKIP, name),
      ]),
    ),
    erasure: reflector.get(DELETION_THROTTLE_KEY, target),
  };
}

describe("throttle decorators", () => {
  it("set no limit and no TTL, so the validated configuration decides", () => {
    for (const metadata of [
      metadataOn(ThrottleWithConfig("medium")),
      metadataOn(ThrottleDeletion()),
    ]) {
      for (const name of THROTTLE_NAMES) {
        expect(metadata[`limit:${name}`]).toBeUndefined();
        expect(metadata[`ttl:${name}`]).toBeUndefined();
      }
    }
  });

  it("skips the other global tiers and leaves the one it names alone", () => {
    const metadata = metadataOn(ThrottleWithConfig("medium"));

    expect(metadata["skip:short"]).toBe(true);
    expect(metadata["skip:long"]).toBe(true);
    expect(metadata["skip:medium"]).toBeUndefined();
  });

  it("opts the erasure route into its tier, and that tier only", () => {
    const metadata = metadataOn(ThrottleDeletion());

    expect(metadata.erasure).toBe(true);
    // The erasure tier is registered but skipped everywhere else, so opting a
    // single route in is the whole mechanism.
    for (const name of THROTTLE_NAMES) {
      expect(metadata[`skip:${name}`]).toBe(true);
    }
  });
});
