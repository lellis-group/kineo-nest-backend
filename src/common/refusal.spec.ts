import { describe, expect, it } from "bun:test";
import { REFUSAL_CODES, refusal } from "./refusal";

describe("refusal", () => {
  it("puts the code in the response body next to the message", () => {
    const exception = refusal(
      REFUSAL_CODES.listingNotDraft,
      "Only draft listings can be published",
    );

    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: "LISTING_NOT_DRAFT",
      message: "Only draft listings can be published",
    });
  });

  it("gives every code a distinct value", () => {
    const codes = Object.values(REFUSAL_CODES);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(0);
  });
});
