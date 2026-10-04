import { describe, expect, it } from "bun:test";
import { PracticeSchema } from "./practice.entity";

describe("PracticeSchema", () => {
  it("does not expose the owner's profile id", () => {
    const parsed = PracticeSchema.parse({
      id: "practice-1",
      ownerId: "profile-1",
      name: "Parc Practice",
      address: "12 rue du Parc",
      city: "Lyon",
      latitude: 45.75,
      longitude: 4.85,
      isPublic: true,
      createdAt: new Date(),
    });

    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed.id).toBe("practice-1");
  });
});
