import { describe, expect, it } from "bun:test";
import { contentSecurityPolicy } from "./security-headers";

/** The directives, whatever shape helmet was handed. */
function directives(nodeEnv?: string): Record<string, string[]> {
  const policy = contentSecurityPolicy(nodeEnv);

  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("the policy is not a directive set");
  }

  return (policy as { directives: Record<string, string[]> }).directives;
}

describe("contentSecurityPolicy", () => {
  it("allows inline scripts only where the documentation UI is served", () => {
    // The UI needs them; nothing else here does, and `'unsafe-inline'` is what
    // neutralises the directive on every response carrying it.
    expect(directives("development").scriptSrc).toContain(`'unsafe-inline'`);
    expect(directives("test").scriptSrc).toContain(`'unsafe-inline'`);
  });

  it("drops them once the environment is hardened", () => {
    for (const nodeEnv of ["production", "staging", undefined]) {
      expect(directives(nodeEnv).scriptSrc).toEqual([`'self'`]);
    }
  });

  it("keeps default-src on the origin either way", () => {
    expect(directives("production").defaultSrc).toEqual([`'self'`]);
    expect(directives("development").defaultSrc).toEqual([`'self'`]);
  });
});
