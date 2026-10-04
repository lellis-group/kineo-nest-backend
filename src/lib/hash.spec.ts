import { describe, expect, it } from "bun:test";
import { deletionHash, deletionPepper } from "./hash";

const PEPPER = "p".repeat(64);

describe("deletionHash", () => {
  it("is stable for the same input and pepper", () => {
    expect(deletionHash("user-1", PEPPER)).toBe(deletionHash("user-1", PEPPER));
  });

  it("differs for the same input under a different pepper", () => {
    expect(deletionHash("user-1", PEPPER)).not.toBe(
      deletionHash("user-1", "q".repeat(64)),
    );
  });

  it("differs for two inputs under the same pepper", () => {
    expect(deletionHash("user-1", PEPPER)).not.toBe(
      deletionHash("user-2", PEPPER),
    );
  });

  it("does not contain the input", () => {
    const email = "alice.martin@medecin.fr";

    expect(deletionHash(email, PEPPER)).not.toContain(email);
    expect(deletionHash(email, PEPPER)).not.toContain("alice");
  });

  it("is a hex digest of the expected length", () => {
    expect(deletionHash("user-1", PEPPER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is not a bare digest, which a dump could reverse from another table", () => {
    // A sha256 of the same value, to show the key is what changes the output.
    const unkeyed =
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    expect(deletionHash("x", PEPPER)).not.toBe(unkeyed);
  });
});

describe("deletionPepper", () => {
  it("accepts a long pepper and trims it", () => {
    expect(deletionPepper({ DELETION_PEPPER: `  ${PEPPER}  ` })).toBe(PEPPER);
  });

  it("refuses to be absent rather than falling back to something predictable", () => {
    expect(() => deletionPepper({})).toThrow("DELETION_PEPPER is required");
    expect(() => deletionPepper({ DELETION_PEPPER: "   " })).toThrow(
      "DELETION_PEPPER is required",
    );
  });

  it("refuses a short pepper", () => {
    expect(() => deletionPepper({ DELETION_PEPPER: "too-short" })).toThrow(
      "at least 32 characters",
    );
  });
});
