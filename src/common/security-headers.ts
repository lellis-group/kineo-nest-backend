import type { HelmetOptions } from "helmet";

import { isHardenedEnv } from "../config/env";

/**
 * The content security policy every answer carries.
 *
 * `'unsafe-inline'` on `script-src`, and the CDN the documentation UI loads from,
 * exist for that UI — which the same origin serves outside a hardened environment
 * only (`src/app.ts` gates it). This API answers JSON, so once the UI is gone the
 * directive goes with it instead of staying to neutralise the policy on every
 * response, including any HTML a future change might serve here.
 */
export function contentSecurityPolicy(
  nodeEnv?: string,
): HelmetOptions["contentSecurityPolicy"] {
  const hardened = isHardenedEnv(nodeEnv);

  return {
    directives: {
      defaultSrc: [`'self'`],
      scriptSrc: hardened
        ? [`'self'`]
        : [`'self'`, `'unsafe-inline'`, "cdn.jsdelivr.net"],
      styleSrc: [
        `'self'`,
        `'unsafe-inline'`,
        "cdn.jsdelivr.net",
        "fonts.googleapis.com",
      ],
      imgSrc: [`'self'`, "data:", "cdn.jsdelivr.net"],
      fontSrc: [`'self'`, "fonts.gstatic.com", "cdn.jsdelivr.net", "data:"],
      connectSrc: [`'self'`, "api.scalar.com"],
    },
  };
}
