import { describe, expect, it } from "bun:test";
import { PracticeSchema } from "./practice.entity";

const practice = {
  id: "practice-1",
  ownerId: "profile-1",
  name: "Clinique des Lilas",
  address: "12 rue de la Paix",
  city: "Lyon",
  latitude: 45.75,
  longitude: 4.85,
  isPublic: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("PracticeSchema", () => {
  it("strips the owner profile id", () => {
    const result = PracticeSchema.parse(practice);
    expect(result).not.toHaveProperty("ownerId");
  });

  it("keeps the fields public consumers rely on", () => {
    const result = PracticeSchema.parse(practice);
    expect(result).toMatchObject({
      id: "practice-1",
      name: "Clinique des Lilas",
      city: "Lyon",
    });
  });
});
