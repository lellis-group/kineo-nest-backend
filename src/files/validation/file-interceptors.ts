import { randomUUID } from "node:crypto";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type Type,
} from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { uploadToDisk } from "@nestjs/storage";
import { FileRules, type UploadKind } from "./file-rules";

type MulterOptions = NonNullable<Parameters<typeof FileInterceptor>[1]>;

/**
 * DI-friendly wrappers around Nest's own `FileInterceptor`/`FilesInterceptor`.
 *
 * The docs build those interceptors in a decorator, where options are fixed at
 * module-load time. Our ceilings come from `ConfigService`, so the wrapper
 * injects `FileRules` and instantiates the official interceptor mixin with the
 * resolved options. The storage engine is still the documented `uploadToDisk`.
 */
function configureInterceptor(
  kind: UploadKind,
  fieldName: string,
  mode: "single" | "array",
) {
  @Injectable()
  class ConfiguredUploadInterceptor implements NestInterceptor {
    private readonly delegate: NestInterceptor;

    constructor(rules: FileRules) {
      const rule = rules.for(kind);
      const options: MulterOptions = {
        storage: uploadToDisk({
          disk: "files",
          contentTypes: rule.contentTypes,
          // Never build a key from the client's `originalname`.
          key: (file) => `${kind}/${randomUUID()}${file.extension}`,
        }),
        limits: rules.limitsFor(kind),
      };

      const Interceptor: Type<NestInterceptor> =
        mode === "single"
          ? FileInterceptor(fieldName, options)
          : FilesInterceptor(fieldName, rule.maxCount, options);
      this.delegate = new Interceptor();
    }

    intercept(context: ExecutionContext, next: CallHandler) {
      return this.delegate.intercept(context, next);
    }
  }

  return ConfiguredUploadInterceptor;
}

export const AvatarFileInterceptor = configureInterceptor(
  "AVATAR",
  "file",
  "single",
);

export const ProfileCvFileInterceptor = configureInterceptor(
  "CV",
  "file",
  "single",
);

export const ListingImagesInterceptor = configureInterceptor(
  "LISTING_IMAGE",
  "images",
  "array",
);
