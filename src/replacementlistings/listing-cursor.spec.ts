import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import {
  decodeListingCursor,
  encodeListingCursor,
  followsInOrder,
} from "./listing-cursor";

const row = {
  id: "listing-7",
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
  startDate: new Date("2026-12-01T00:00:00.000Z"),
  urgent: true,
};

describe("listing cursor", () => {
  it("round-trips the keys of the row it was cut after", () => {
    const token = encodeListingCursor("urgent", row);

    expect(decodeListingCursor(token, "urgent")).toEqual(row);
  });

  it("refuses a token minted under another ordering", () => {
    const token = encodeListingCursor("recent", row);

    expect(() => decodeListingCursor(token, "startDate")).toThrow(
      BadRequestException,
    );
  });

  it("refuses a token that is not one", () => {
    for (const token of [
      "not-base64-json",
      Buffer.from("null").toString("base64url"),
      Buffer.from(
        '{"s":"recent","i":"x","c":"nope","d":"nope","u":true}',
      ).toString("base64url"),
    ]) {
      expect(() => decodeListingCursor(token, "recent")).toThrow(
        BadRequestException,
      );
    }
  });

  it("puts every non-urgent posting after an urgent cursor", () => {
    expect(followsInOrder(row, "urgent")).toMatchObject({
      OR: [{ urgent: false }, { AND: [{ urgent: true }, expect.anything()] }],
    });
  });

  it("keeps a non-urgent cursor among the non-urgent postings", () => {
    expect(followsInOrder({ ...row, urgent: false }, "urgent")).toMatchObject({
      AND: [{ urgent: false }, expect.anything()],
    });
  });
});
