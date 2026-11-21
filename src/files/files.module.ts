import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { FilesLifecycleService } from "./files-lifecycle.service";
import {
  AvatarFileInterceptor,
  ListingImagesInterceptor,
  ProfileCvFileInterceptor,
} from "./validation/file-interceptors";
import { FileRules } from "./validation/file-rules";

@Module({
  controllers: [FilesController],
  providers: [
    FileRules,
    FilesService,
    FilesLifecycleService,
    AvatarFileInterceptor,
    ProfileCvFileInterceptor,
    ListingImagesInterceptor,
  ],
  exports: [FilesService, FilesLifecycleService],
})
export class FilesModule {}
