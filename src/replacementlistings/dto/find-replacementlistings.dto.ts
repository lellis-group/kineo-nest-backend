import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  paginationBoundsRefine,
  paginationQueryShape,
  paginationWithinBounds,
} from "../../common/pagination";
import { ListingStatus, Specialty } from "../../generated/prisma/enums";

/**
 * Query parameters are plain strings: `z.coerce.boolean()` would turn the
 * literal string "false" into `true`, inverting the filter. Accept only
 * explicit boolean values or the strings "true"/"false".
 */
const BooleanQueryParam = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((value) => value === true || value === "true");

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
    status: z
      .enum(ListingStatus)
      .optional()
      .describe(
        "Filter by status. Only meaningful on the caller's own listings: the public feed is always OPEN.",
      ),
    startDateFrom: z.iso
      .datetime()
      .optional()
      .describe("Only listings starting on or after this date (ISO 8601)"),
    startDateTo: z.iso
      .datetime()
      .optional()
      .describe("Only listings starting on or before this date (ISO 8601)"),
    ...paginationQueryShape,
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
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindReplacementListingsDto extends createZodDto(
  FindReplacementListingsSchema,
) {}
