import { z } from "zod";
import { latLongsPaired } from "../../common/validation/lat-long";
import { CITY_REGEX, textField } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";

export const CreatePracticeObjectSchema = z
  .object({
    name: textField(200, "Name").describe("Name of the practice or clinic"),
    address: textField(300, "Address").describe(
      "Street address of the practice",
    ),
    city: textField(100, "City")
      .regex(
        CITY_REGEX,
        "City must contain only letters, spaces, hyphens or apostrophes",
      )
      .describe("City where the practice is located"),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Latitude of the practice location"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Longitude of the practice location"),
    isPublic: z
      .boolean()
      .optional()
      .describe("Whether the practice is visible in the public directory"),
  })
  .strict();

export const CreatePracticeSchema = CreatePracticeObjectSchema.refine(
  latLongsPaired,
  {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  },
);

export class CreatePracticeDto extends createZodDto(CreatePracticeSchema) {}
