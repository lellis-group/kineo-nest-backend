import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  paginationBoundsRefine,
  paginationQueryShape,
  paginationWithinBounds,
} from "../../common/pagination";

export const FindPracticesSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Filter by practice name"),
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Filter by city"),
    lat: z.coerce
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("Latitude for geographic radius search"),
    lng: z.coerce
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("Longitude for geographic radius search"),
    radiusKm: z.coerce
      .number()
      .positive()
      .max(500)
      .optional()
      .describe("Search radius in kilometers"),
    ...paginationQueryShape,
  })
  .strict()
  .superRefine((data, ctx) => {
    const geoParams = [data.lat, data.lng, data.radiusKm].filter(
      (value) => value !== undefined,
    ).length;

    if (geoParams > 0 && geoParams < 3) {
      ctx.addIssue({
        code: "custom",
        message: "lat, lng and radiusKm must be provided together",
        path: ["lat"],
      });
    }
  })
  .refine(paginationWithinBounds, paginationBoundsRefine);

export class FindPracticesDto extends createZodDto(FindPracticesSchema) {}
