import { describe, expect, it } from "bun:test";
import { CreatePracticeSchema } from "./create-practice.dto";
import { FindPracticesSchema } from "./find-practices.dto";
import { UpdatePracticeSchema } from "./update-practice.dto";

const validPractice = {
  name: "Clinique des Lilas",
  address: "12 rue de la Paix",
  city: "Lyon",
};

describe("Practice DTO security", () => {
  describe("CreatePracticeSchema", () => {
    it("accepts a valid practice", () => {
      expect(CreatePracticeSchema.safeParse(validPractice).success).toBe(true);
    });

    it("rejects unknown keys (mass-assignment protection)", () => {
      const result = CreatePracticeSchema.safeParse({
        ...validPractice,
        ownerId: "profile-1",
        verified: true,
      });
      expect(result.success).toBe(false);
    });

    it("trims and requires non-empty strings", () => {
      const trimmed = CreatePracticeSchema.safeParse({
        name: "  Clinique  ",
        address: " 12 rue de la Paix ",
        city: " Lyon ",
      });
      expect(trimmed.success).toBe(true);
      if (trimmed.success) {
        expect(trimmed.data.name).toBe("Clinique");
        expect(trimmed.data.address).toBe("12 rue de la Paix");
        expect(trimmed.data.city).toBe("Lyon");
      }

      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          city: "   ",
        }).success,
      ).toBe(false);
    });

    it("requires latitude and longitude together", () => {
      const single = CreatePracticeSchema.safeParse({
        ...validPractice,
        latitude: 45.75,
      });
      expect(single.success).toBe(false);

      const both = CreatePracticeSchema.safeParse({
        ...validPractice,
        latitude: 45.75,
        longitude: 4.85,
      });
      expect(both.success).toBe(true);
    });

    it("rejects out-of-range coordinates", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          latitude: 91,
          longitude: 4.85,
        }).success,
      ).toBe(false);
    });

    it("rejects non-finite coordinates", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          latitude: Number.POSITIVE_INFINITY,
          longitude: 4.85,
        }).success,
      ).toBe(false);
    });

    it("rejects forbidden control or invisible characters", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          name: "Clinique\u200Bdes Lilas", // zero-width space
        }).success,
      ).toBe(false);
    });

    it("rejects markup in a city", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          city: "<script>",
        }).success,
      ).toBe(false);
    });

    it("accepts a postcode typed as a free-text city", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          city: "Lyon 69000",
        }).success,
      ).toBe(true);
    });

    it("refuses a department code contradicting the commune code", () => {
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          cityCodeInsee: "75056",
          departmentCode: "69",
        }).success,
      ).toBe(false);
      expect(
        CreatePracticeSchema.safeParse({
          ...validPractice,
          cityCodeInsee: "75056",
          departmentCode: "75",
        }).success,
      ).toBe(true);
    });
  });

  describe("UpdatePracticeSchema", () => {
    it("rejects unknown keys", () => {
      expect(
        UpdatePracticeSchema.safeParse({ ownerId: "profile-2" }).success,
      ).toBe(false);
    });

    it("accepts a partial update", () => {
      expect(UpdatePracticeSchema.safeParse({ name: "New name" }).success).toBe(
        true,
      );
      expect(UpdatePracticeSchema.safeParse({}).success).toBe(true);
    });

    it("enforces lat/long pairing on partial updates", () => {
      expect(UpdatePracticeSchema.safeParse({ longitude: 4.85 }).success).toBe(
        false,
      );
    });
  });

  describe("FindPracticesSchema", () => {
    it("rejects unknown query parameters", () => {
      expect(
        FindPracticesSchema.safeParse({ ownerId: "profile-1" }).success,
      ).toBe(false);
    });

    it("requires lat, lng and radiusKm to be provided together", () => {
      const partialGeo = FindPracticesSchema.safeParse({
        lat: "45.75",
        lng: "4.85",
      });
      expect(partialGeo.success).toBe(false);

      const fullGeo = FindPracticesSchema.safeParse({
        lat: "45.75",
        lng: "4.85",
        radiusKm: "10",
      });
      expect(fullGeo.success).toBe(true);
    });

    it("coerces integer pagination", () => {
      const result = FindPracticesSchema.safeParse({ page: "3", limit: "10" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(10);
      }
    });

    it("rejects pagination deeper than 10,000 results", () => {
      expect(
        FindPracticesSchema.safeParse({ page: "101", limit: "100" }).success,
      ).toBe(false);
      expect(
        FindPracticesSchema.safeParse({ page: "100", limit: "100" }).success,
      ).toBe(true);
    });

    it("rejects non-finite coordinates in the geo search", () => {
      expect(
        FindPracticesSchema.safeParse({
          lat: "1e999",
          lng: "4.85",
          radiusKm: "10",
        }).success,
      ).toBe(false);
    });
  });
});
