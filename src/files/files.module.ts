import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { FilesLifecycleService } from "./files-lifecycle.service";
import { FILE_STORAGE } from "./storage/file-storage";
import { RustFsStorage } from "./storage/rustfs.storage";
import {
  AvatarFileInterceptor,
  ListingImagesInterceptor,
  ProfileCvFileInterceptor,
} from "./validation/file-interceptors";
import {
  AvatarFilePipe,
  ListingImageFilePipe,
  ProfileCvFilePipe,
} from "./validation/file-pipes";
import { FileRules } from "./validation/file-rules";

@Module({
  controllers: [FilesController],
  providers: [
    FileRules,
    { provide: FILE_STORAGE, useClass: RustFsStorage },
    FilesService,
    FilesLifecycleService,
    AvatarFileInterceptor,
    ProfileCvFileInterceptor,
    ListingImagesInterceptor,
    AvatarFilePipe,
    ProfileCvFilePipe,
    ListingImageFilePipe,
  ],
  exports: [FilesService, FilesLifecycleService],
})
export class FilesModule {}
