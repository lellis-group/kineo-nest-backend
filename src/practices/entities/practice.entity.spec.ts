import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { toPracticeDto } from "../practice.mapper";
import { PaginatedPracticesSchema, PracticeSchema } from "./practice.entity";

describe("PracticeSchema", () => {
  it("does not expose the owner's profile id", () => {
    const row = {
      id: "practice-1",
      ownerId: "profile-1",
      name: "Parc Practice",
      address: "12 rue du Parc",
      city: "Lyon",
      latitude: 45.75,
      longitude: 4.85,
      isPublic: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const parsed = PracticeSchema.parse(toPracticeDto(row));

    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed.id).toBe("practice-1");
    // `z.iso.datetime()` is what the OpenAPI generator can express and the
    // serializer parses — a raw `Date` used to answer both with a refusal.
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("compiles to JSON Schema, which the OpenAPI generator runs on every boot", () => {
    // `nestjs-zod` asks zod for the JSON Schema of every registered response
    // type while `SwaggerModule.createDocument` runs; a `z.date()` anywhere
    // made the whole document refuse to generate, and both documentation
    // endpoints answered with the router's error instead of a schema name. The
    // document answers every schema against as an ISO string now.
    for (const schema of [PracticeSchema, PaginatedPracticesSchema]) {
      const compiled = z.toJSONSchema(schema);
      expect(JSON.stringify(compiled)).not.toContain(
        '"createdAt":{"type":"object"}',
      );
    }
  });
});
