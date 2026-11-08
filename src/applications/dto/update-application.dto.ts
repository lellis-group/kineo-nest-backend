import { z } from "zod";
import { textField } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";

export const UpdateApplicationSchema = z
  .object({
    message: textField(2000, "Message").describe(
      "Updated message, only editable while the application is pending",
    ),
  })
  .strict();

export class UpdateApplicationDto extends createZodDto(
  UpdateApplicationSchema,
) {}
