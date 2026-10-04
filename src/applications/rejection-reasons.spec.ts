import { describe, expect, it } from "bun:test";
import {
  isPlatformRejectionReason,
  PLATFORM_REJECTION_REASON_VALUES,
  PLATFORM_REJECTION_REASONS,
} from "./rejection-reasons";

describe("platform rejection reasons", () => {
  it("is a closed, non-empty set", () => {
    expect(PLATFORM_REJECTION_REASON_VALUES.length).toBeGreaterThan(0);

    for (const reason of PLATFORM_REJECTION_REASON_VALUES) {
      expect(reason.trim()).toBe(reason);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("gives every reason a distinct value", () => {
    expect(new Set(PLATFORM_REJECTION_REASON_VALUES).size).toBe(
      PLATFORM_REJECTION_REASON_VALUES.length,
    );
  });

  it("recognises its own reasons", () => {
    for (const reason of PLATFORM_REJECTION_REASON_VALUES) {
      expect(isPlatformRejectionReason(reason)).toBe(true);
    }
  });

  it("recognises the reason cancel used to write before the copy was reviewed", () => {
    expect(isPlatformRejectionReason("The listing has been cancelled")).toBe(
      true,
    );
  });

  it("does not claim a reason a practice typed itself", () => {
    expect(isPlatformRejectionReason("Profil déjà pourvu")).toBe(false);
  });

  it("is keyed by the event it describes", () => {
    expect(PLATFORM_REJECTION_REASONS.listingCancelled).toBe(
      "L'annonce a été annulée",
    );
  });
});
