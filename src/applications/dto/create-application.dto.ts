import { z } from "zod";
import { textField } from "../../common/validation/text";
import { createZodDto } from "../../common/zod-dto";

export const CreateApplicationSchema = z
  .object({
    listingId: z.cuid().describe("Id of the replacement listing (Prisma cuid)"),
    message: textField(2000, "Message")
      .optional()
      .describe("Optional message to the practice owner"),
  })
  .strict();

export class CreateApplicationDto extends createZodDto(
  CreateApplicationSchema,
) {}
