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
