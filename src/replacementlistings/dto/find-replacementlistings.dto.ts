import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { ListingStatus, Specialty } from "../../generated/prisma/enums";

/**
 * Query parameters are plain strings: `z.coerce.boolean()` would turn the
 * literal string "false" into "true", inverting the filter. Accept only
 * explicit boolean values or the strings "true"/"false".
 */
const BooleanQueryParam = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((value) => value === true || value === "true");

/**
 * One listing status, or several at once.
 *
 * The management screen buckets listings into groups a practice reasons about
 * ("en cours" spans OPEN / IN_DISCUSSION / FULL), so a single-value enum would
 * force the client to fetch everything and bucket locally — which breaks the
 * moment the collection is paginated. Comma-separated, the usual shape for an
 * array on a query string.
 */
const ListingStatusFilter = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(ListingStatus)).min(1))
  .optional()
  .describe("Filter by one or more listing statuses (comma-separated)");

export const FindReplacementListingsSchema = z
  .object({
    specialty: z
      .enum(Specialty)
      .optional()
      .describe("Filter by medical specialty"),
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Filter by practice city"),
    urgent: BooleanQueryParam.optional().describe(
      "Filter urgent listings only",
    ),
    status: ListingStatusFilter,
    startDateFrom: z.iso
      .datetime()
      .optional()
      .describe("Only listings starting on or after this date (ISO 8601)"),
    startDateTo: z.iso
      .datetime()
      .optional()
      .describe("Only listings starting on or before this date (ISO 8601)"),
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1)
      .describe("Page number, starting at 1"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Number of results per page, max 100"),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.startDateFrom &&
      data.startDateTo &&
      new Date(data.startDateFrom) > new Date(data.startDateTo)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "startDateFrom must be on or before startDateTo",
        path: ["startDateTo"],
      });
    }
  })
  .refine((data) => data.page * data.limit <= 10_000, {
    message:
      "page and limit combination is too large (no more than 10,000 results can be requested)",
    path: ["page"],
  });

export class FindReplacementListingsDto extends createZodDto(
  FindReplacementListingsSchema,
) {}
