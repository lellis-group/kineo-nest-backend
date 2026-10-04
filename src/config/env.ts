const NON_PROD_ENVS = new Set(["development", "test"]);

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
