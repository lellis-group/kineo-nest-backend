import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  ApplicationDecisionSource,
  ApplicationStatus,
  ListingStatus,
  ProfileType,
  Specialty,
} from "../../generated/prisma/enums";

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
  /**
   * True once the candidate's account was erased (art. 17 GDPR). Every personal
   * field above is then blank by construction, so the receiving practice needs
   * to be told why rather than shown an empty card.
   */
  anonymized: z
    .boolean()
    .describe("Candidate erased their account; personal fields are blank"),
});

export const ApplicationSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  applicantId: z.string(),
  status: z.enum(ApplicationStatus),
  decisionSource: z
    .enum(ApplicationDecisionSource)
    .nullable()
    .describe(
      "Who decided, for the applicant's own reading. Null while the application is still open: nobody has decided yet.",
    ),
  message: z.string().nullable(),
  rejectionReason: z.string().nullable(),
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
 * Totals per decision source, alongside the status counts.
 *
 * `undecided` holds the applications nobody has ruled on — `decisionSource` is
 * null there, which `groupBy` cannot key on, so it is counted separately
 * instead of being spread across the enum members.
 *
 * Both maps are always full: a filter the caller did not apply does not shrink
 * them, which is what lets a tab counter stay put while paging.
 */
export const ApplicationDecisionCountsSchema = z.object({
  total: z.number(),
  CANDIDATE_WITHDREW: z.number(),
  PRACTICE_ACCEPTED: z.number(),
  PRACTICE_REJECTED: z.number(),
  ANOTHER_CANDIDATE_SELECTED: z.number(),
  LISTING_CLOSED: z.number(),
  LISTING_CLOSED_NO_CANDIDATE: z.number(),
  LISTING_CANCELLED: z.number(),
  LISTING_ERASED: z.number(),
  CANDIDATE_UNAVAILABLE: z.number(),
  undecided: z.number(),
});

export const PaginatedApplicationsSchema = z.object({
  data: z.array(ApplicationSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    counts: ApplicationStatusCountsSchema,
    decisionCounts: ApplicationDecisionCountsSchema,
  }),
});

export class PaginatedApplications extends createZodDto(
  PaginatedApplicationsSchema,
) {}
