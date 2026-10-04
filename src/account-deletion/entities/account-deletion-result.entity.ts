import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const AccountDeletionResultSchema = z
  .object({
    success: z
      .literal(true)
      .describe("Personal data anonymized and access revoked"),
    message: z
      .literal("Account deleted")
      .describe(
        "Confirmation message. Nothing is hard-deleted here: the row is anonymized immediately and dropped after ACCOUNT_PURGE_GRACE_DAYS, which is what leaves room for an art. 17(3) hold",
      ),
  })
  .strict();

export class AccountDeletionResult extends createZodDto(
  AccountDeletionResultSchema,
) {}
