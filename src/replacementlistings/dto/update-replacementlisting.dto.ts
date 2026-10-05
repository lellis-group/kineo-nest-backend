import { createZodDto } from "nestjs-zod";
import { ReplacementListingObjectSchema } from "./create-replacementlisting.dto";

/**
 * Every field optional.
 *
 * There is no `practiceId` to make optional, and that is the point: the listing's
 * practice is part of what the listing is rather than something about it, so it
 * lives in the create schema only. Moving a listing between practices is not an
 * edit this API offers, and leaving the key out means a request that tries gets
 * a 400 for being unrecognised rather than a silent no-op.
 *
 * The date rule is not the create rule made partial. On create both dates are
 * present and compared directly; here either may be absent, so the pair is only
 * checked when both arrive — and the service reconciles a single given date
 * against the stored row, which a schema cannot do.
 */
export const UpdateReplacementListingSchema =
  ReplacementListingObjectSchema.partial()
    .strict()
    .superRefine((data: { startDate?: string; endDate?: string }, ctx) => {
      if (
        data.startDate &&
        data.endDate &&
        new Date(data.startDate) >= new Date(data.endDate)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "startDate must be before endDate",
          path: ["endDate"],
        });
      }
    });

export class UpdateReplacementListingDto extends createZodDto(
  UpdateReplacementListingSchema,
) {}
