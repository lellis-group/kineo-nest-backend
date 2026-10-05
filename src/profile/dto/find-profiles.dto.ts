import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  paginationBoundsRefine,
  paginationQueryShape,
  paginationWithinBounds,
} from "../../common/pagination";
import { ProfileType, Specialty } from "../../generated/prisma/enums";

export const FindProfilesSchema = z
  .object({
    specialty: z
      .enum(Specialty)
      .optional()
      .describe("Filter by medical specialty"),
    profileType: z
      .enum(ProfileType)
      .optional()
      .describe("Filter by profile status"),
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Filter by city"),
    ...paginationQueryShape,
  })
  .strict()
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindProfilesDto extends createZodDto(FindProfilesSchema) {}
