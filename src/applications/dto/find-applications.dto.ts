import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  ApplicationDecisionSource,
  ApplicationStatus,
} from "../../generated/prisma/enums";

/**
 * One value, or several separated by commas — `status=REJECTED,WITHDRAWN`.
 *
 * Kept as an array in the inferred type even for a single value, so the service
 * has one shape to handle; it turns that into an equality or an `in` at the
 * query. Enum objects are passed rather than arrays so the literal members
 * survive: an array would widen the result back to `string[]`, and Prisma
 * rejects a plain `string` where it wants the enum.
 */
const csvEnum = <T extends Record<string, string>>(values: T) =>
  z
    .string()
    .transform((raw) => raw.split(",").map((part) => part.trim()))
    .pipe(z.array(z.enum(values)).min(1));

export const FindApplicationsSchema = z
  .object({
    listingId: z
      .cuid()
      .optional()
      .describe("Filter by listing id (Prisma cuid)"),
    status: csvEnum(ApplicationStatus)
      .optional()
      .describe("Filter by application status; comma-separated for several"),
    decisionSource: csvEnum(ApplicationDecisionSource)
      .optional()
      .describe(
        "Filter by who decided; comma-separated for several. Null (still open) is not selectable here",
      ),
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
  .refine((data) => data.page * data.limit <= 10_000, {
    message:
      "page and limit combination is too large (no more than 10,000 results can be requested)",
    path: ["page"],
  });

export class FindApplicationsDto extends createZodDto(FindApplicationsSchema) {}
