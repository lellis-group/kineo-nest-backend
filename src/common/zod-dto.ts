import { createZodDto as createZodDtoBase } from "nestjs-zod";

/**
 * A property as `nestjs-zod` hands it to Swagger's metadata factory.
 *
 * Only the fields this file reads are named; the rest of the record is passed
 * through untouched.
 */
type OpenApiProperty = {
  type?: string | string[];
  anyOf?: Array<{ type: string }>;
  nullable?: boolean;
};

type OpenApiProperties = Record<string, OpenApiProperty>;

/** A DTO class, reduced to what this file has to reach. */
type DtoWithFactory = {
  _OPENAPI_METADATA_FACTORY: () => OpenApiProperties;
  Output?: DtoWithFactory;
};

/**
 * Rewrites zod's compact `type: ["number", "null"]` into OpenAPI 3.0.
 *
 * `zod` writes a nullable primitive as `{ type: ["number", "null"] }`. In a root
 * property, `@nestjs/swagger` reads that array as "an array of that element
 * type" — a nullable `number` is published as `number[]` and the `null` is
 * dropped, which is worse than not publishing the schema at all: a generated
 * client would type `latitude` as an array. Nested, the array survives as-is,
 * and `type: ["number", "null"]` is not valid OpenAPI 3.0 either.
 *
 * Two-member nullable unions become `{ type, nullable: true }`; anything else
 * keeps its members under `anyOf`, which Swagger understands at both depths.
 * The walk covers the whole subtree because a DTO property may carry an inline
 * object, an array of them, or a `$defs` entry.
 */
function fixTypeArrays(node: Record<string, unknown>): void {
  const type = node.type;

  if (Array.isArray(type)) {
    const members = type.filter(
      (member): member is string =>
        typeof member === "string" && member !== "null",
    );

    if (type.includes("null") && members.length === 1) {
      node.type = members[0];
      node.nullable = true;
    } else {
      node.anyOf = type.map((member) => ({ type: member }));
      delete node.type;
    }
  }

  for (const value of Object.values(node)) walk(value);
}

function walk(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }

  if (typeof value !== "object" || value === null) return;
  fixTypeArrays(value as Record<string, unknown>);
}

function fixNullableTypes(properties: OpenApiProperties): OpenApiProperties {
  for (const property of Object.values(properties)) walk(property);
  return properties;
}

function patch(dto: DtoWithFactory): void {
  const factory = dto._OPENAPI_METADATA_FACTORY.bind(dto);
  dto._OPENAPI_METADATA_FACTORY = () => fixNullableTypes(factory());

  const output = Object.getOwnPropertyDescriptor(dto, "Output")?.get;
  if (!output) return;

  Object.defineProperty(dto, "Output", {
    // `this` is the class the getter was reached through — the DTO declared with
    // `extends createZodDto(...)`, not the anonymous base this wrapper patched.
    // Calling with the base would name every output schema `AugmentedZodDto_Output`.
    get(this: DtoWithFactory) {
      const derived = output.call(this) as DtoWithFactory;
      patch(derived);
      return derived;
    },
  });
}

/**
 * `createZodDto`, with the nullable-property fix applied.
 *
 * Kept as the single entry point every DTO goes through, rather than
 * post-processing the generated document in `app.ts`: the document no longer
 * knows which schema came from which zod type, and the `null` is already gone
 * by then. Here the original JSON Schema is still at hand.
 *
 * Drop this wrapper and go back to `createZodDto` from `nestjs-zod` once the
 * upstream bug is fixed — check `Practice.latitude` in `/api-json` after the
 * upgrade: it must be `{ "type": "number", "nullable": true }`, not an array.
 */
export const createZodDto: typeof createZodDtoBase = ((schema, options) => {
  const dto = createZodDtoBase(schema, options);
  patch(dto as unknown as DtoWithFactory);
  return dto;
}) as typeof createZodDtoBase;
