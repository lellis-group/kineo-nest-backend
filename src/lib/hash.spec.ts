import { describe, expect, it } from "bun:test";
import { anonymizedEmailFor, deletionHash } from "./hash";

const pepper = "a".repeat(32);

describe("deletionHash", () => {
  it("is deterministic for the same input", () => {
    expect(deletionHash("user-1", pepper)).toBe(deletionHash("user-1", pepper));
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(deletionHash("  Claire.MARTIN@Example.COM ", pepper)).toBe(
      deletionHash("claire.martin@example.com", pepper),
    );
  });

  it("produces different fingerprints under different peppers", () => {
    expect(deletionHash("user-1", pepper)).not.toBe(
      deletionHash("user-1", "b".repeat(32)),
    );
  });

  it("does not expose the input", () => {
    expect(deletionHash("user-1", pepper)).not.toContain("user-1");
  });
});

describe("anonymizedEmailFor", () => {
  it("is deterministic per user id", () => {
    expect(anonymizedEmailFor("user-1", pepper)).toBe(
      anonymizedEmailFor("user-1", pepper),
    );
  });

  it("differs between users so the unique index holds", () => {
    expect(anonymizedEmailFor("user-1", pepper)).not.toBe(
      anonymizedEmailFor("user-2", pepper),
    );
  });

  it("uses a reserved non-deliverable domain and hides the user id", () => {
    const email = anonymizedEmailFor("user-1", pepper);

    expect(email.endsWith("@deleted.invalid")).toBe(true);
    expect(email).not.toContain("user-1");
  });
});
