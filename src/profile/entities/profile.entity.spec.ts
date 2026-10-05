import { describe, expect, it } from "bun:test";
import { ProfileSchema, PublicProfileSchema } from "./profile.entity";

const profile = {
  id: "profile-1",
  userId: "user-1",
  rppsNumber: "12345678901",
  specialty: "GENERALIST",
  profileType: "INSTALLED",
  verified: true,
  isPublic: true,
  city: "Lyon",
  latitude: 45.75,
  longitude: 4.85,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ProfileSchema", () => {
  it("keeps userId, which the owner needs to recognise their own profile", () => {
    expect(ProfileSchema.parse(profile).userId).toBe("user-1");
  });
});

describe("PublicProfileSchema", () => {
  it("strips the RPPS number and the account id", () => {
    const parsed = PublicProfileSchema.parse(profile);

    expect(parsed).not.toHaveProperty("rppsNumber");
    expect(parsed).not.toHaveProperty("userId");
    expect(parsed.id).toBe("profile-1");
  });

  it("keeps what the search and the card display", () => {
    const parsed = PublicProfileSchema.parse(profile);

    expect(parsed).toMatchObject({
      specialty: "GENERALIST",
      city: "Lyon",
      isPublic: true,
    });
  });
});
