import { describe, expect, it } from "bun:test";
import {
  ListingFacetsSchema,
  ReplacementListingSchema,
} from "./replacementlisting.entity";

describe("ReplacementListingSchema", () => {
  it("does not expose the profile that created the listing", () => {
    const parsed = ReplacementListingSchema.parse({
      id: "listing-1",
      practiceId: "practice-1",
      practice: {
        id: "practice-1",
        name: "Cabinet République",
        city: "Lyon",
        latitude: 45.764,
        longitude: 4.8357,
      },
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

  /**
   * The practice travels with the listing because the browse screen cannot place
   * a posting on a map without coordinates, and it used to have nothing to place.
   */
  it("carries the practice, coordinates included", () => {
    const parsed = ReplacementListingSchema.parse({
      id: "listing-1",
      practiceId: "practice-1",
      practice: {
        id: "practice-1",
        name: "Cabinet République",
        city: "Lyon",
        latitude: 45.764,
        longitude: 4.8357,
      },
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

    expect(parsed.practice.city).toBe("Lyon");
    expect(parsed.practice.latitude).toBe(45.764);
  });

  /**
   * A practice with no geocoded address is a normal row, not an error: the
   * coordinates were nullable in the schema before the feed could reach them, so
   * existing listings sit at NULL. Rejecting them would empty the feed of
   * perfectly valid postings.
   */
  it("accepts a practice that has never been geocoded", () => {
    const parsed = ReplacementListingSchema.parse({
      id: "listing-1",
      practiceId: "practice-1",
      practice: {
        id: "practice-1",
        name: "Cabinet République",
        city: "Lyon",
        latitude: null,
        longitude: null,
      },
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

    expect(parsed.practice.latitude).toBeNull();
  });

  /**
   * The feed only needs where a posting is and whose it is. The owner's profile
   * and the practice's internal bookkeeping stay behind, because the DTO is
   * anonymous-readable.
   */
  it("does not expose the practice owner", () => {
    const parsed = ReplacementListingSchema.parse({
      id: "listing-1",
      practiceId: "practice-1",
      practice: {
        id: "practice-1",
        name: "Cabinet République",
        city: "Lyon",
        latitude: 45.764,
        longitude: 4.8357,
        ownerId: "profile-1",
        address: "12 rue confidentielle",
        createdAt: "2026-01-01T08:00:00.000Z",
      },
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

    expect(parsed.practice).not.toHaveProperty("ownerId");
    expect(parsed.practice).not.toHaveProperty("address");
  });
});

describe("ListingFacetsSchema", () => {
  it("reports every specialty, including the ones with nothing", () => {
    const parsed = ListingFacetsSchema.parse({
      total: 3,
      urgent: 1,
      bySpecialty: {
        GENERALIST: 2,
        DENTIST: 0,
        DERMATOLOGIST: 1,
        PSYCHIATRIST: 0,
        OTHER: 0,
      },
    });

    expect(parsed.total).toBe(3);
    expect(parsed.urgent).toBe(1);
    // A zero has to survive parsing as a zero: the panel draws one row per
    // specialty, and a missing key would drop the row rather than empty it.
    expect(parsed.bySpecialty.PSYCHIATRIST).toBe(0);
  });
});
