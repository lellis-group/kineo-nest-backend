import { describe, expect, it } from "bun:test";
import { CreateReplacementListingSchema } from "./create-replacementlisting.dto";
import { FindReplacementListingsSchema } from "./find-replacementlistings.dto";
import { UpdateReplacementListingSchema } from "./update-replacementlisting.dto";

const validListing = {
  title: "Remplacement de novembre",
  practiceId: "clh8zq6w70000wqf4vlonix5a",
  startDate: "2026-09-10T08:00:00.000Z",
  endDate: "2026-09-12T08:00:00.000Z",
  specialty: "GENERALIST",
};

describe("ReplacementListing DTO security", () => {
  describe("CreateReplacementListingSchema", () => {
    it("accepts a valid listing", () => {
      expect(
        CreateReplacementListingSchema.safeParse(validListing).success,
      ).toBe(true);
    });

    it("requires a title", () => {
      const { title: _title, ...withoutTitle } = validListing;
      expect(
        CreateReplacementListingSchema.safeParse(withoutTitle).success,
      ).toBe(false);
    });

    it("trims the title and rejects empty or invisible characters", () => {
      const trimmed = CreateReplacementListingSchema.safeParse({
        ...validListing,
        title: "  Remplacement de novembre  ",
      });
      expect(trimmed.success).toBe(true);
      if (trimmed.success) {
        expect(trimmed.data.title).toBe("Remplacement de novembre");
      }

      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          title: "   ",
        }).success,
      ).toBe(false);

      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          title: "Remplacement\u200Burgent",
        }).success,
      ).toBe(false);
    });

    it("rejects a title longer than 150 characters", () => {
      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          title: "x".repeat(151),
        }).success,
      ).toBe(false);
    });

    it("rejects unknown keys (mass-assignment protection)", () => {
      const result = CreateReplacementListingSchema.safeParse({
        ...validListing,
        status: "OPEN",
        createdById: "profile-1",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a practiceId that is not a Prisma cuid", () => {
      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          practiceId: "not-a-cuid",
        }).success,
      ).toBe(false);
    });

    it("requires startDate to be before endDate", () => {
      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          startDate: "2026-09-12T08:00:00.000Z",
          endDate: "2026-09-10T08:00:00.000Z",
        }).success,
      ).toBe(false);
    });

    it("trims and bounds the description", () => {
      const result = CreateReplacementListingSchema.safeParse({
        ...validListing,
        description: "  Remplacement du mois de septembre.  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.description).toBe(
          "Remplacement du mois de septembre.",
        );
      }

      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          description: "   ",
        }).success,
      ).toBe(false);
    });

    it("allows newlines but rejects invisible control characters in the description", () => {
      const withNewline = CreateReplacementListingSchema.safeParse({
        ...validListing,
        description: "Remplacement\ndu mois de septembre.",
      });
      expect(withNewline.success).toBe(true);

      const withZeroWidth = CreateReplacementListingSchema.safeParse({
        ...validListing,
        description: "Remplacement\u200Bdu mois",
      });
      expect(withZeroWidth.success).toBe(false);
    });

    it("rejects a fractional maxApplications", () => {
      expect(
        CreateReplacementListingSchema.safeParse({
          ...validListing,
          maxApplications: 2.5,
        }).success,
      ).toBe(false);
    });
  });

  describe("UpdateReplacementListingSchema", () => {
    it("rejects unknown keys", () => {
      expect(
        UpdateReplacementListingSchema.safeParse({
          status: "OPEN",
        }).success,
      ).toBe(false);
    });

    it("accepts partial updates", () => {
      expect(
        UpdateReplacementListingSchema.safeParse({ urgent: true }).success,
      ).toBe(true);
      expect(UpdateReplacementListingSchema.safeParse({}).success).toBe(true);
      expect(
        UpdateReplacementListingSchema.safeParse({
          title: "Nouveau titre",
        }).success,
      ).toBe(true);
    });

    it("validates date order when both dates are updated", () => {
      expect(
        UpdateReplacementListingSchema.safeParse({
          startDate: "2026-10-01T08:00:00.000Z",
          endDate: "2026-09-01T08:00:00.000Z",
        }).success,
      ).toBe(false);
    });
  });

  describe("FindReplacementListingsSchema", () => {
    it("rejects unknown query parameters", () => {
      expect(
        FindReplacementListingsSchema.safeParse({ ownerId: "profile-1" })
          .success,
      ).toBe(false);
    });

    it("rejects a status outside the enum", () => {
      expect(
        FindReplacementListingsSchema.safeParse({ status: "PUBLISHED" })
          .success,
      ).toBe(false);
    });

    it("accepts a status, which is what buckets the owner's own listings", () => {
      expect(
        FindReplacementListingsSchema.safeParse({ status: "OPEN" }).success,
      ).toBe(true);
    });

    it("accepts known filters", () => {
      const result = FindReplacementListingsSchema.safeParse({
        specialty: "DENTIST",
        city: " Lyon ",
        urgent: "true",
        status: "FILLED",
        page: "2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.city).toBe("Lyon");
        expect(result.data.urgent).toBe(true);
        expect(result.data.page).toBe(2);
      }
    });

    it("correctly parses urgent=false instead of inverting the filter", () => {
      const notUrgent = FindReplacementListingsSchema.safeParse({
        urgent: "false",
      });
      expect(notUrgent.success).toBe(true);
      if (notUrgent.success) {
        expect(notUrgent.data.urgent).toBe(false);
      }
    });

    it("rejects ambiguous boolean values", () => {
      expect(
        FindReplacementListingsSchema.safeParse({ urgent: "yes" }).success,
      ).toBe(false);
      expect(
        FindReplacementListingsSchema.safeParse({ urgent: "1" }).success,
      ).toBe(false);
    });

    it("rejects an inverted date range", () => {
      expect(
        FindReplacementListingsSchema.safeParse({
          startDateFrom: "2026-10-01T00:00:00.000Z",
          startDateTo: "2026-09-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });

    it("rejects pagination deeper than 10,000 results", () => {
      expect(
        FindReplacementListingsSchema.safeParse({
          page: "200",
          limit: "100",
        }).success,
      ).toBe(false);
      expect(
        FindReplacementListingsSchema.safeParse({
          page: "100",
          limit: "100",
        }).success,
      ).toBe(true);
    });
  });
});
