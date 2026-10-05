import { describe, expect, it } from "bun:test";
import { ReplacementListingSchema } from "./replacementlisting.entity";

describe("ReplacementListingSchema", () => {
  it("does not expose the profile that created the listing", () => {
    const parsed = ReplacementListingSchema.parse({
      id: "listing-1",
      practiceId: "practice-1",
      createdById: "profile-1",
      title: "General practitioner",
      startDate: "2026-09-10T08:00:00.000Z",
      endDate: "2026-09-12T08:00:00.000Z",
      specialty: "GENERALIST",
      status: "OPEN",
      urgent: false,
      description: null,
      maxApplications: null,
      applicationsCount: 0,
      createdAt: "2026-08-20T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:00.000Z",
    });

    expect(parsed).not.toHaveProperty("createdById");
    expect(parsed.id).toBe("listing-1");
  });
});
