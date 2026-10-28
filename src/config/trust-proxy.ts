/**
 * The Express `trust proxy` setting, derived from the same `TRUST_PROXY_IPS`
 * list better-auth walks the forwarded chain with. Naming the proxies beats
 * counting hops: a CDN in front of the load balancer would otherwise leave a
 * proxy address as the client the throttler keys on.
 */
export function trustProxySetting(
  enabled: boolean,
  trustedIps: string[],
): false | 1 | string[] {
  if (!enabled) {
    return false;
  }

  return trustedIps.length > 0 ? trustedIps : 1;
}
