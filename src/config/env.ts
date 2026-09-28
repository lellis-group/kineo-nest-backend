const NON_PROD_ENVS = new Set(["development", "test"]);

export function isHardenedEnv(nodeEnv?: string | null): boolean {
  const normalized = nodeEnv?.trim().toLowerCase() || "production";
  return !NON_PROD_ENVS.has(normalized);
}
