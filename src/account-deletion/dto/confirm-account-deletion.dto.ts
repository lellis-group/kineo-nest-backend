import { z } from "zod";
import { createZodDto } from "../../common/zod-dto";
import { tokenSchema } from "../../lib/auth/schemas";

export const ConfirmAccountDeletionSchema = z
  .object({
    token: tokenSchema.describe(
      "Single-use deletion confirmation token from the email link",
    ),
  })
  .strict();

export class ConfirmAccountDeletionDto extends createZodDto(
  ConfirmAccountDeletionSchema,
) {}
