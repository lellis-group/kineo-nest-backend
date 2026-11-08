import { z } from "zod";
import { textField } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";

export const WithdrawApplicationSchema = z
  .object({
    withdrawnReason: textField(500, "Withdrawal reason")
      .optional()
      .describe("Optional reason for withdrawing"),
  })
  .strict();

export class WithdrawApplicationDto extends createZodDto(
  WithdrawApplicationSchema,
) {}
