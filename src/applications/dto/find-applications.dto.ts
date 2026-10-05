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
    // The situation rather than the status. Three of the four rejections are the
    // same status, so this is what tells them apart; it sits beside `status`
    // rather than replacing it, because the status is what the chips above group
    // by and a caller may want both.
    bucket: z
      .enum(REJECTION_BUCKETS)
      .optional()
      .describe(
        "Filter by situation: another candidate retained, the posting ended, or refused by the practice",
      ),
    ...paginationQueryShape,
  })
  .strict()
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindApplicationsDto extends createZodDto(FindApplicationsSchema) {}
