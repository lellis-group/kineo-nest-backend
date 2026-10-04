import { describe, expect, it } from "bun:test";
import { ListingStatus } from "../generated/prisma/enums";
import {
  APPLICABLE_LISTING_STATUSES,
  deriveListingStatus,
  isRecruitingListingStatus,
  isTerminalListingStatus,
  TERMINAL_LISTING_STATUSES,
} from "./listing-status";

const EVERY_STATUS = Object.values(ListingStatus);

describe("deriveListingStatus", () => {
  it("is OPEN with no active application", () => {
    for (const current of [
      ListingStatus.OPEN,
      ListingStatus.IN_DISCUSSION,
      ListingStatus.FULL,
    ]) {
      expect(
        deriveListingStatus({
          current,
          activeApplications: 0,
          maxApplications: null,
        }),
      ).toBe(ListingStatus.OPEN);
    }
  });

  it("is IN_DISCUSSION below the cap", () => {
    expect(
      deriveListingStatus({
        current: ListingStatus.OPEN,
        activeApplications: 1,
        maxApplications: 3,
      }),
    ).toBe(ListingStatus.IN_DISCUSSION);
  });

  it("is FULL at the cap", () => {
    expect(
      deriveListingStatus({
        current: ListingStatus.IN_DISCUSSION,
        activeApplications: 3,
        maxApplications: 3,
      }),
    ).toBe(ListingStatus.FULL);
  });

  it("treats a null cap as unlimited", () => {
    expect(
      deriveListingStatus({
        current: ListingStatus.OPEN,
        activeApplications: 99,
        maxApplications: null,
      }),
    ).toBe(ListingStatus.IN_DISCUSSION);
  });

  it("never resurrects a terminal listing", () => {
    for (const current of TERMINAL_LISTING_STATUSES) {
      expect(
        deriveListingStatus({
          current,
          activeApplications: 0,
          maxApplications: null,
        }),
      ).toBe(current);
      expect(
        deriveListingStatus({
          current,
          activeApplications: 5,
          maxApplications: 1,
        }),
      ).toBe(current);
    }
  });

  it("never publishes a draft", () => {
    expect(
      deriveListingStatus({
        current: ListingStatus.DRAFT,
        activeApplications: 0,
        maxApplications: null,
      }),
    ).toBe(ListingStatus.DRAFT);
  });
});

describe("listing status guards", () => {
  it("names FILLED as terminal, because it carries the accepted placement", () => {
    expect(isTerminalListingStatus(ListingStatus.FILLED)).toBe(true);
    expect(isRecruitingListingStatus(ListingStatus.FILLED)).toBe(true);
  });

  it("keeps the two lists disjoint on the out-of-circulation statuses", () => {
    for (const status of [
      ListingStatus.CLOSED,
      ListingStatus.CLOSED_NO_CANDIDATE,
      ListingStatus.CANCELLED,
    ]) {
      expect(isRecruitingListingStatus(status)).toBe(false);
    }
  });

  it("only admits OPEN and IN_DISCUSSION to a new application", () => {
    for (const status of EVERY_STATUS) {
      expect(APPLICABLE_LISTING_STATUSES.includes(status)).toBe(
        status === ListingStatus.OPEN || status === ListingStatus.IN_DISCUSSION,
      );
    }
  });

  it("gives every status a home: recruiting, terminal or draft", () => {
    for (const status of EVERY_STATUS) {
      expect(
        isRecruitingListingStatus(status) ||
          isTerminalListingStatus(status) ||
          status === ListingStatus.DRAFT,
      ).toBe(true);
    }
  });
});
