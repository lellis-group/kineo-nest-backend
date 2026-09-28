import { describe, expect, it } from "bun:test";
import { ReplacementListingSchema } from "./replacementlisting.entity";

const listing = {
  id: "listing-1",
  practiceId: "practice-1",
  createdById: "profile-1",
  title: "Remplacement de novembre",
  startDate: "2026-09-10T08:00:00.000Z",
  endDate: "2026-09-12T08:00:00.000Z",
  specialty: "GENERALIST",
  status: "OPEN",
  urgent: false,
  description: null,
  maxApplications: null,
  applicationsCount: 0,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

describe("ReplacementListingSchema", () => {
  it("strips the creating profile id", () => {
    const result = ReplacementListingSchema.parse(listing);
    expect(result).not.toHaveProperty("createdById");
  });

  it("keeps the practice reference and the fields consumers rely on", () => {
    const result = ReplacementListingSchema.parse(listing);
    expect(result).toMatchObject({
      id: "listing-1",
      practiceId: "practice-1",
      status: "OPEN",
    });
  });
});
