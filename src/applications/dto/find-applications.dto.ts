import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  paginationBoundsRefine,
  paginationQueryShape,
  paginationWithinBounds,
} from "../../common/pagination";
import { ApplicationStatus } from "../../generated/prisma/enums";

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
    ...paginationQueryShape,
  })
  .strict()
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindApplicationsDto extends createZodDto(FindApplicationsSchema) {}
