import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { PracticeSchema } from "./entities/practice.entity";
import { PRACTICE_GEO_COLUMNS } from "./geo-query";

describe("PRACTICE_GEO_COLUMNS", () => {
  it("selects every field the serialized Practice requires", () => {
    // The geographic read is a raw SQL query with a hard-coded column list. A
    // field added to the response schema but not to this list makes the
    // serializer refuse every radius search — which the e2e suite caught once.
    const selected = new Set(
      [...PRACTICE_GEO_COLUMNS.matchAll(/p\."(\w+)"/g)].map((match) =>
        match[1] ? String(match[1]) : "",
      ),
    );
    const schema = z.toJSONSchema(PracticeSchema) as { required?: string[] };

    for (const field of schema.required ?? []) {
      expect(selected.has(field), field).toBe(true);
    }
  });
});
