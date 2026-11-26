import { geoCodesAgree } from "../../common/validation/geo";
import { latLongsPaired } from "../../common/validation/lat-long";
import { createZodDto } from "../../common/zod-dto";
import { CreateProfileObjectSchema } from "./create-profile.dto";

export const UpdateProfileSchema = CreateProfileObjectSchema.partial()
  .refine(latLongsPaired, {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  })
  .refine(geoCodesAgree, {
    message: "departmentCode must match cityCodeInsee",
    path: ["departmentCode"],
  });

export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
