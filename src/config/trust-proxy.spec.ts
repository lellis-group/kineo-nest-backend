import { describe, expect, it } from "bun:test";

import { trustProxySetting } from "./trust-proxy";

describe("trustProxySetting", () => {
  it("trusts nobody when the proxy is not trusted", () => {
    expect(trustProxySetting(false, ["10.0.0.0/8"])).toBe(false);
  });

  it("keeps the single-hop default when no proxy list is named", () => {
    expect(trustProxySetting(true, [])).toBe(1);
  });

  it("walks the chain by address when the list names the proxies", () => {
    expect(trustProxySetting(true, ["10.0.0.0/8", "192.0.2.10"])).toEqual([
      "10.0.0.0/8",
      "192.0.2.10",
    ]);
  });
});
