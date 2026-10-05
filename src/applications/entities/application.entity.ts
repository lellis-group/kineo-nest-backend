import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { PaginationMetaSchema } from "../../common/pagination";
import {
  ApplicationStatus,
  ListingStatus,
  ProfileType,
  Specialty,
} from "../../generated/prisma/enums";
import { REJECTION_BUCKETS } from "../rejection-buckets";

/**
 * Embedded listing snapshot so cards/details need no extra fetches or
 * visibility-rule lookups.
 */
export const ApplicationListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  specialty: z.enum(Specialty),
  status: z.enum(ListingStatus),
  urgent: z.boolean(),
  description: z.string().nullable(),
  practice: z.object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    city: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  }),
});

/**
 * Applicant profile embedded in application responses (public display data).
 */
export const ApplicationApplicantSchema = z.object({
  id: z.string(),
  specialty: z.enum(Specialty),
  profileType: z.enum(ProfileType),
  city: z.string().nullable(),
  verified: z.boolean(),
  user: z.object({
    name: z.string().nullable(),
    image: z.string().nullable(),
  }),
});

export const ApplicationSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  applicantId: z.string(),
  status: z.enum(ApplicationStatus),
  message: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /**
   * Which situation a rejection is, or null when it is none of them.
   *
   * Derived rather than stored: it is a reading of the two fields above, and a
   * stored copy would be free to disagree with them. The client gets it so it can
   * group and label without re-deriving the classification — which is what would
   * otherwise have to be written twice, once in SQL and once in TypeScript.
   */
  rejectionBucket: z.enum(REJECTION_BUCKETS).nullable(),
  withdrawnReason: z.string().nullable(),
  viewedAt: z.iso.datetime().nullable(),
  respondedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  listing: ApplicationListingSchema.optional(),
  applicant: ApplicationApplicantSchema.optional(),
});

export class Application extends createZodDto(ApplicationSchema) {}

/**
 * Server-computed totals for the whole collection, independent of any
 * applied filter; `total` backs the "all" tab.
 */
export const ApplicationStatusCountsSchema = z.object({
  total: z.number().describe("Count across all statuses ('all' tab)"),
  PENDING: z.number(),
  SHORTLISTED: z.number(),
  ACCEPTED: z.number(),
  REJECTED: z.number(),
  WITHDRAWN: z.number(),
});

/**
 * Per-situation totals, over the whole collection like `counts`.
 *
 * Optional because an older backend does not send it and a rolling deploy must not
 * take the page down over a counter: every reader treats it as possibly absent and
 * falls back to zero, which shows an empty chip rather than a broken page.
 */
export const ApplicationBucketCountsSchema = z.object({
  PASSED_OVER: z.number(),
  POSTING_ENDED: z.number(),
  REFUSED: z.number(),
});

export const PaginatedApplicationsSchema = z.object({
  data: z.array(ApplicationSchema),
  meta: PaginationMetaSchema.extend({
    counts: ApplicationStatusCountsSchema,
    bucketCounts: ApplicationBucketCountsSchema.optional(),
  }),
});

export class PaginatedApplications extends createZodDto(
  PaginatedApplicationsSchema,
) {}
