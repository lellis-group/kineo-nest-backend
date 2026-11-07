import { ApiResponse } from "@nestjs/swagger";
import { z } from "zod";
import { createZodDto } from "./zod-dto";

/**
 * The error body `HttpExceptionFilter` answers with in a hardened environment.
 *
 * The filter is the only place error bodies are built, so these schemas exist to
 * be referenced by `@ApiResponse({ type })` on every handler that can refuse —
 * the shape was transcribed from the filter into each code reader's head until
 * now, and a client generated from the OpenAPI document had no way to type an
 * error at all.
 *
 * It is the hardened shape deliberately: `nodeEnv` of development delegates to
 * Nest's own default body, which is a leftover of the filter being written, and
 * a client only ever sees the production body. Not documented here: the bodies
 * `/api/auth/*` answers with, which better-auth builds on its own and never
 * passes through this filter.
 */
export const ApiErrorSchema = z.object({
  statusCode: z
    .number()
    .describe("HTTP status of the answer, repeated in the body"),
  message: z
    .string()
    .describe(
      "A sentence a human can read; 5xx answers always say “Internal server error”",
    ),
  code: z
    .string()
    .optional()
    .describe(
      "Stable identifier for a refusal a client branches on — the values of REFUSAL_CODES (listing, application and profile refusals) and ERASURE_ERROR_CODES (erasure). Absent when the error has none",
    ),
  path: z
    .string()
    .optional()
    .describe("Request path, without its query string"),
  timestamp: z.iso.datetime().describe("When the answer was sent"),
});

export class ApiError extends createZodDto(ApiErrorSchema) {}

/**
 * The body a body/query DTO failing zod validation produces.
 *
 * Routes that validate a DTO can answer 400 with this *and* — when they also
 * enforce a domain rule — with `ApiError`, which is why `ApiBadRequest` documents
 * the 400 as a union rather than asking each handler to guess which one applies.
 */
export const ApiValidationErrorSchema = z.object({
  statusCode: z.literal(400).describe("Always 400"),
  message: z.literal("Validation failed").describe("Constant"),
  errors: z
    .array(
      z.object({
        path: z
          .array(z.string().or(z.number()))
          .describe(
            "Where the value sat in the request, one step per array entry",
          ),
        message: z.string().describe("What the schema rejected about it"),
      }),
    )
    .describe("One entry per rejected value"),
});

export class ApiValidationError extends createZodDto(
  ApiValidationErrorSchema,
) {}

const ERROR_REF = { $ref: "#/components/schemas/ApiError" };
const VALIDATION_ERROR_REF = {
  $ref: "#/components/schemas/ApiValidationError",
};

/**
 * Documents a 400 whose body is either a refusal or a validation failure.
 *
 * Both schemas are served whether or not a handler references them by `type`:
 * `app.ts` passes them as `extraModels` when the document is built, so the `$ref`s
 * here always resolve.
 */
export function ApiBadRequest(description: string): MethodDecorator {
  return ApiResponse({
    status: 400,
    description,
    schema: { anyOf: [ERROR_REF, VALIDATION_ERROR_REF] },
  });
}
