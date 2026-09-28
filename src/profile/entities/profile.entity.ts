import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { ProfileType, Specialty } from "../../generated/prisma/enums";

export const ProfileSchema = z.object({
  id: z.string(),
  userId: z.string(),
  rppsNumber: z.string().nullable(),
  specialty: z.enum(Specialty),
  profileType: z.enum(ProfileType),
  verified: z.boolean(),
  isPublic: z.boolean(),
  city: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export class Profile extends createZodDto(ProfileSchema) {}

export const PublicProfileSchema = ProfileSchema.omit({
  rppsNumber: true,
  userId: true,
});

export class PublicProfile extends createZodDto(PublicProfileSchema) {}

export const PaginatedPublicProfilesSchema = z.object({
  data: z.array(PublicProfileSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
});

export class PaginatedPublicProfiles extends createZodDto(
  PaginatedPublicProfilesSchema,
) {}
