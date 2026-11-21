import { z } from "zod";
import { createZodDto } from "../../common/zod-dto";
import { StoredFileKind } from "../../generated/prisma/enums";

export const StoredFileSchema = z.object({
  id: z.string(),
  kind: z.enum(StoredFileKind),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  position: z.number().int(),
  url: z.string().describe("Authenticated URL that streams this file"),
  createdAt: z.iso.datetime(),
});

export class StoredFileDto extends createZodDto(StoredFileSchema) {}

export const StoredFileListSchema = z.array(StoredFileSchema);

export class StoredFileListDto extends createZodDto(StoredFileListSchema) {}
