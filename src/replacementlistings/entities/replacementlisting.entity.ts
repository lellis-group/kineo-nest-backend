import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { ListingStatus, Specialty } from "../../generated/prisma/enums";

export const ReplacementListingSchema = z.object({
  id: z.string(),
  practiceId: z.string(),
  title: z.string(),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  specialty: z.enum(Specialty),
  status: z.enum(ListingStatus),
  urgent: z.boolean(),
  description: z.string().nullable(),
  maxApplications: z.number().nullable(),
  applicationsCount: z.number(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ReplacementListing extends createZodDto(
  ReplacementListingSchema,
) {}

/**
 * Per-status totals, independent of any applied `status` filter and of the
 * current page but honouring every other filter the list applies. The screen's
 * bucket tabs render these and never derive a counter from the loaded page, so
 * switching bucket cannot make the numbers jump — and they add up to the same
 * population `meta.total` counts.
 */
export const ListingStatusCountsSchema = z.object({
  total: z.number().describe("Count across all statuses"),
  DRAFT: z.number(),
  OPEN: z.number(),
  IN_DISCUSSION: z.number(),
  FULL: z.number(),
  FILLED: z.number(),
  CLOSED: z.number(),
  CLOSED_NO_CANDIDATE: z
    .number()
    .describe("Closed without anyone being retained"),
  CANCELLED: z.number(),
});

export const PaginatedReplacementListingsSchema = z.object({
  data: z.array(ReplacementListingSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    /** Only `findMine` returns them; `findAll` is a public, status-OPEN search. */
    counts: ListingStatusCountsSchema.optional(),
  }),
});

export class PaginatedReplacementListings extends createZodDto(
  PaginatedReplacementListingsSchema,
) {}
