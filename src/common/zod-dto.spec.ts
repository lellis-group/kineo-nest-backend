import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createZodDto } from "./zod-dto";

/**
 * The workaround in `zod-dto.ts` is only worth keeping if it produces the shape
 * Swagger is supposed to see. These tests read the metadata factory directly,
 * which is exactly what `SwaggerModule.createDocument` does.
 */

type Property = Record<string, unknown>;

function propertiesOf(dto: {
  _OPENAPI_METADATA_FACTORY(): unknown;
}): Record<string, Property> {
  return dto._OPENAPI_METADATA_FACTORY() as Record<string, Property>;
}

describe("createZodDto", () => {
  it("publishes a nullable number as a nullable number, not an array", () => {
    const dto = createZodDto(z.object({ latitude: z.number().nullable() }));

    expect(propertiesOf(dto).latitude).toMatchObject({
      type: "number",
      nullable: true,
    });
    expect(propertiesOf(dto).latitude.type).not.toBe("array");
  });

  it("reaches the nullable fields of a generic inside an array", () => {
    const item = z.object({ city: z.string().nullable() });
    const dto = createZodDto(z.object({ data: z.array(item) }));

    const data = propertiesOf(dto).data as {
      items: { properties: Record<string, Property> };
    };

    expect(data.items.properties.city).toMatchObject({
      type: "string",
      nullable: true,
    });
  });

  it("keeps a wider union under anyOf rather than guessing a type", () => {
    const dto = createZodDto(
      z.object({ id: z.union([z.string(), z.number()]) }),
    );

    expect(propertiesOf(dto).id).toMatchObject({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("leaves a genuine array alone", () => {
    const dto = createZodDto(z.object({ tags: z.array(z.string()) }));

    expect(propertiesOf(dto).tags).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  it("fixes the output DTO too", () => {
    const dto = createZodDto(z.object({ page: z.number().nullable() }));

    expect(propertiesOf(dto.Output).page).toMatchObject({
      type: "number",
      nullable: true,
    });
  });
});
