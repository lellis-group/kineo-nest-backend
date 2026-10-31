import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { toProfileDto } from "../profile.mapper";
import {
  PaginatedPublicProfilesSchema,
  ProfileSchema,
  PublicProfileSchema,
} from "./profile.entity";

/**
 * The row the storage answers, passed through the mapper the services read
 * their return sites through — the schemas demand ISO strings, so a fixture
 * that carried raw `Date`s would test a shape nobody answers.
 */
const row = {
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
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const profile = toProfileDto(row);

describe("the wire shape of a profile", () => {
  it("carries its timestamps as ISO strings, not Date objects", () => {
    // The OpenAPI generator cannot express a `Date`, and the serializer parses
    // against exactly this shape — the fixture above only parses because the
    // mapper made it wire-shaped.
    expect(profile.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(profile.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
  });
});

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

describe("the profile schemas compile to JSON Schema", () => {
  // `nestjs-zod` asks zod for the JSON Schema of every registered response type
  // while `SwaggerModule.createDocument` runs; a `z.date()` anywhere made the
  // whole document refuse to generate, and both documentation endpoints
  // answered with the router's error instead of a schema name.
  it("without a shape JSON Schema cannot express", () => {
    for (const schema of [
      ProfileSchema,
      PublicProfileSchema,
      PaginatedPublicProfilesSchema,
    ]) {
      const compiled = z.toJSONSchema(schema);
      const body = JSON.stringify(compiled);
      expect(body).toContain('"type":"string"');
      expect(body).not.toMatch(/"createdAt":\{"type":"(?:object|null)"\}/);
    }
  });
});
