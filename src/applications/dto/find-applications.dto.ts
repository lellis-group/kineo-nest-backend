import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  paginationBoundsRefine,
  paginationQueryShape,
  paginationWithinBounds,
} from "../../common/pagination";
import { ApplicationStatus } from "../../generated/prisma/enums";
import { REJECTION_BUCKETS } from "../rejection-buckets";

export const FindApplicationsSchema = z
  .object({
    listingId: z
      .cuid()
      .optional()
      .describe("Filter by listing id (Prisma cuid)"),
    status: z
      .enum(ApplicationStatus)
      .optional()
      .describe("Filter by application status"),
    // The applicant-facing situation rather than the status: three of them are all
    // `REJECTED`, and which one is the whole difference between "the practice
    // refused you" and "another candidate was kept".
    bucket: z
      .enum(REJECTION_BUCKETS)
      .optional()
      .describe(
        "Filter by situation, for a rejected application: refused by the practice, another candidate retained, or the posting ended",
      ),
    ...paginationQueryShape,
  })
  .strict()
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindApplicationsDto extends createZodDto(FindApplicationsSchema) {}
