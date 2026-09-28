import { describe, expect, it } from "bun:test";
import { PublicProfileSchema } from "./profile.entity";

const profile = {
  id: "profile-1",
  userId: "user-1",
  rppsNumber: "12345678901",
  specialty: "GENERALIST",
  profileType: "REPLACEMENT",
  verified: true,
  isPublic: true,
  city: "Lyon",
  latitude: 45.75,
  longitude: 4.85,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("PublicProfileSchema", () => {
  it("strips the RPPS number", () => {
    const result = PublicProfileSchema.parse(profile);
    expect(result).not.toHaveProperty("rppsNumber");
  });

  it("strips the owning user id", () => {
    const result = PublicProfileSchema.parse(profile);
    expect(result).not.toHaveProperty("userId");
  });

  it("keeps the fields public consumers rely on", () => {
    const result = PublicProfileSchema.parse(profile);
    expect(result).toMatchObject({
      id: "profile-1",
      city: "Lyon",
      latitude: 45.75,
      longitude: 4.85,
    });
  });
});
