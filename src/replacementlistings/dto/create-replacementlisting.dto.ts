import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { textField } from "../../common/validation/text";
import { Specialty } from "../../generated/prisma/enums";

/**
 * The listing's own fields, once.
 *
 * Exported as an object schema because `update-replacementlisting.dto.ts` is the
 * same eight fields again. Practices and profiles have been built this way since
 * their update DTOs were written; this pair had the same seven fields spelled out
 * a second time, descriptions and all, and the copies could only agree by
 * coincidence.
 *
 * `practiceId` is part of a listing's identity rather than its content, so it is
 * in neither half: created once, never edited. The update DTO omits it explicitly
 * rather than inheriting and hiding it, so the difference is readable here.
 */
export const ReplacementListingObjectSchema = z.object({
  title: textField(150, "Title").describe(
    "Public title of the listing, shown to replacement candidates",
  ),
  startDate: z.iso
    .datetime()
    .describe("Start date of the replacement period (ISO 8601)"),
  endDate: z.iso
    .datetime()
    .describe("End date of the replacement period (ISO 8601)"),
  specialty: z
    .enum(Specialty)
    .describe("Medical specialty required for this replacement"),
  urgent: z
    .boolean()
    .optional()
    .describe("Marks the listing as a last-minute urgent replacement"),
  description: textField(2000, "Description")
    .optional()
    .describe("Free text details about the replacement"),
  maxApplications: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Optional cap on the number of active applications"),
});

export const CreateReplacementListingSchema =
  ReplacementListingObjectSchema.extend({
    practiceId: z
      .cuid()
      .describe("Id of the practice this listing belongs to (Prisma cuid)"),
  })
    .strict()
    // Both dates are required here, so they can be compared outright.
    .refine((data) => new Date(data.startDate) < new Date(data.endDate), {
      message: "startDate must be before endDate",
      path: ["endDate"],
    });

export class CreateReplacementListingDto extends createZodDto(
  CreateReplacementListingSchema,
) {}
