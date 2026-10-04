import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const PracticeSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  city: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  isPublic: z.boolean(),
  createdAt: z.date(),
});

export class Practice extends createZodDto(PracticeSchema) {}

export const PaginatedPracticesSchema = z.object({
  data: z.array(PracticeSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
});

export class PaginatedPractices extends createZodDto(
  PaginatedPracticesSchema,
) {}
