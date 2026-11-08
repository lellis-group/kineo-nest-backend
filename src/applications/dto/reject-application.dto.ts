import { z } from "zod";
import { textField } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";

export const RejectApplicationSchema = z
  .object({
    rejectionReason: textField(500, "Rejection reason")
      .optional()
      .describe("Optional reason shared with the applicant"),
  })
  .strict();

export class RejectApplicationDto extends createZodDto(
  RejectApplicationSchema,
) {}
