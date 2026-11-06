import { z } from "zod";
import { latLongsPaired } from "../../common/validation/lat-long";
import { CITY_REGEX } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";
import { ProfileType, Specialty } from "../../generated/prisma/enums";

export const CreateProfileObjectSchema = z
  .object({
    specialty: z.enum(Specialty).describe("Medical specialty of the profile"),
    profileType: z
      .enum(ProfileType)
      .describe("Status: installed doctor, replacement doctor, or both"),
    rppsNumber: z
      .string()
      .trim()
      .max(50)
      .transform((value) => value.replace(/[\s.\-]/g, ""))
      .pipe(z.string().regex(/^\d{11}$/))
      .optional()
      .describe(
        "11-digit RPPS number of the healthcare professional (spaces, dots and dashes are accepted)",
      ),
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        CITY_REGEX,
        "City must contain only letters, spaces, hyphens or apostrophes",
      )
      .optional()
      .describe("Main city of practice"),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Latitude of the main practice location"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Longitude of the main practice location"),
    isPublic: z
      .boolean()
      .optional()
      .describe("Whether the profile is visible in the public directory"),
  })
  .strict();

export const CreateProfileSchema = CreateProfileObjectSchema.refine(
  latLongsPaired,
  {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  },
);

export class CreateProfileDto extends createZodDto(CreateProfileSchema) {}
