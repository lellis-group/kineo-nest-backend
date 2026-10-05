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
 * Totals per status, so the tabs on the owner's own listings can stay stable
 * across pages and filters. `total` backs the "all" tab.
 */
export const ListingStatusCountsSchema = z.object({
  total: z.number(),
  DRAFT: z.number(),
  OPEN: z.number(),
  IN_DISCUSSION: z.number(),
  FULL: z.number(),
  FILLED: z.number(),
  CLOSED: z.number(),
  CLOSED_NO_CANDIDATE: z.number(),
  CANCELLED: z.number(),
});

export const PaginatedReplacementListingsSchema = z.object({
  data: z.array(ReplacementListingSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    counts: ListingStatusCountsSchema.optional(),
  }),
});

export class PaginatedReplacementListings extends createZodDto(
  PaginatedReplacementListingsSchema,
) {}
