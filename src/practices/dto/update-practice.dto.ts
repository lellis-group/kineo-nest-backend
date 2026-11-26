import { geoCodesAgree } from "../../common/validation/geo";
import { latLongsPaired } from "../../common/validation/lat-long";
import { createZodDto } from "../../common/zod-dto";
import { CreatePracticeObjectSchema } from "./create-practice.dto";

export const UpdatePracticeSchema = CreatePracticeObjectSchema.partial()
  .refine(latLongsPaired, {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  })
  .refine(geoCodesAgree, {
    message: "departmentCode must match cityCodeInsee",
    path: ["departmentCode"],
  });

export class UpdatePracticeDto extends createZodDto(UpdatePracticeSchema) {}
