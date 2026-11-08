import { latLongsPaired } from "../../common/validation/lat-long";
import { createZodDto } from "../../common/zod-dto";
import { CreateProfileObjectSchema } from "./create-profile.dto";

export const UpdateProfileSchema = CreateProfileObjectSchema.partial().refine(
  latLongsPaired,
  {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  },
);

export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
