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

/** How the reader wants the postings ordered. */
export const ListingSort = z.enum(["recent", "urgent", "startDate"]);

/**
 * The fields that select postings, without the ones that describe a page.
 *
 * A shape rather than a schema, because the two DTOs built on it carry
 * different refinements — the paginated one has the `page × limit` bound, the
 * map's one has no paging at all — and `z.object.omit()` refuses to run on a
 * schema that has any. Field-by-field instead, which is what keeps a filter
 * from existing on one path and being absent on the other.
 */
const listingFilterShape = {
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
  urgent: BooleanQueryParam.optional().describe("Filter urgent listings only"),
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
  sort: ListingSort.optional().describe("Ordering of the results"),
};

export const FindReplacementListingsSchema = z
  .object({ ...listingFilterShape, ...paginationQueryShape })
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

/**
 * The map's read: the filters without the paging, which the map has no use for.
 *
 * The same fields as the paginated one, and notably **not** the same as
 * `/facets`: `specialty` is honoured here. The distribution panel drops it on
 * purpose — a panel reading « Médecine générale — 12 » under a Dermatologie
 * filter answers a question nobody asked — but a map showing postings of
 * another specialty than the list is simply wrong.
 */
export const FindPlacesSchema = z
  .object(listingFilterShape)
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
  });

export class FindPlacesDto extends createZodDto(FindPlacesSchema) {}

/**
 * The map's other question: not "where are they" but "where does this one sit".
 *
 * The filters of the map's own read plus the posting to place, and the page size
 * the reader is paging the list with — because the answer is a page number, and a
 * page number means nothing without the size it was computed against. A client
 * that asks with a different `limit` than the one it pages with gets a different
 * page, which is not a different answer but a wrong one; sending it here makes
 * the two one value on both sides.
 */
export const FindPageOfSchema = z
  .object({
    ...listingFilterShape,
    /** The posting whose page is being asked for. */
    id: z.string().trim().min(1).describe("The posting to place"),
    limit: paginationQueryShape.limit,
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

export class FindPageOfDto extends createZodDto(FindPageOfSchema) {}
