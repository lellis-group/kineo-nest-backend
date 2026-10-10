const NON_PROD_ENVS = new Set(["development", "test"]);

/**
 * The value `NODE_ENV` gets when it is absent.
 *
 * Declared once because four files used to spell `"development"` as the default —
 * the configuration factory, its validation schema, and both branches of the auth
 * env reader. Any one of them defaulting to development meant a deployment that
 * never set `NODE_ENV` (the Dockerfile does not) reached the application with
 * Swagger served, non-`Secure` cookies and unsanitised error bodies.
 *
 * `isHardenedEnv` already treats a missing value as hardened; this makes that
 * reachable, so the gates close by default instead of by intent.
 */
export const DEFAULT_NODE_ENV = "production";

/**
 * Everything that is not development or test is treated as production.
 *
 * Gating on `=== "production"` meant a staging host with NODE_ENV=staging
 * served raw error messages and unsecured cookies, so the default for an unset
 * or misspelled value has to be the hardened one.
 */
export function isHardenedEnv(nodeEnv?: string | null): boolean {
  const normalized = nodeEnv?.trim().toLowerCase() || "production";
  return !NON_PROD_ENVS.has(normalized);
}

/**
 * A boolean flag from the environment, and the value to use when it is absent.
 *
 * The configuration schema writes a default back into `process.env`, so a flat
 * `.default("false")` there would erase the difference between "never set" and
 * "set to false". Keeping such a flag optional in the schema and resolving it
 * here preserves it, which is what lets a gate close by default.
 */
export function envBoolean(
  raw: string | undefined,
  whenUnset: boolean,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return whenUnset;
  }
  return normalized === "true";
}
