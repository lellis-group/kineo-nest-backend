import { z } from "zod";
import { PaginationMetaSchema } from "../../common/pagination";
import { createZodDto } from "../../common/zod-dto";
import {
  DecisionSource,
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
 *
 * `anonymized` is the trustworthy signal of an erased account (art. 17 GDPR):
 * the backend blanks `user.name` and `user.image`, and a blank name alone is
 * what an applicant with no name looks like otherwise, so the flag is what has
 * to carry the meaning — the client greets the row with a fixed label rather
 * than rehearsed blankness.
 */
export const ApplicationApplicantSchema = z.object({
  id: z.string(),
  specialty: z.enum(Specialty),
  profileType: z.enum(ProfileType),
  city: z.string().nullable(),
  verified: z.boolean(),
  anonymized: z.boolean(),
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
  /**
   * Who ended the application, when one did — null while it is open.
   *
   * `rejectionBucket` names *which situation* a rejection is, derived from what
   * the row already stores; this is stored, and it is the field the labels
   * branch on: « Refusée par le cabinet » and « retirée par le candidat » —
   * both `REJECTED` — read nothing alike, and the client must not re-derive
   * either from the status.
   */
  decisionSource: z.enum(DecisionSource).nullable(),
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
    /**
     * Open applications the practice has not opened yet, over the whole
     * collection.
     *
     * A qualifier on `counts.PENDING + counts.SHORTLISTED`, and defined here
     * rather than left to the client for the same reason `counts` is: the
     * dashboard used to page the collection to compute it. Optional for a
     * rolling deploy — a client reads its absence as zero.
     */
    unseenOpenCount: z.number().optional(),
    /**
     * Applications that got an answer, withdrawn ones excluded.
     *
     * The rate on the dashboard is this over `total - WITHDRAWN`, and both ends
     * of that division have to come from the same place or the percentage
     * describes two different collections. Optional for a rolling deploy.
     */
    respondedCount: z.number().optional(),
  }),
});

export class PaginatedApplications extends createZodDto(
  PaginatedApplicationsSchema,
) {}
