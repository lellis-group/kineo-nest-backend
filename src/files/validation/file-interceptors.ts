import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import { uploadToDisk } from "@nestjs/storage";
import multer, { type Options } from "multer";
import { FileRules, type UploadKind } from "./file-rules";

/**
 * Multer interceptors whose rules come from configuration at construction time.
 *
 * Nest's `FileInterceptor` takes its options as a decorator argument, evaluated
 * before DI exists. These classes take `FileRules` through the constructor, so
 * the ceilings in `.env` actually bound the parser rather than only a later
 * validator. The storage engine is the one `@nestjs/storage` ships: it detects
 * the real type from the bytes and streams the upload onto the configured disk.
 */
function configureInterceptor(
  fieldName: string,
  mode: "single" | "array",
  kind: UploadKind,
) {
  @Injectable()
  class ConfiguredUploadInterceptor implements NestInterceptor {
    private readonly upload: multer.Multer;

    constructor(rules: FileRules) {
      const rule = rules.for(kind);
      const options: Options = {
        storage: uploadToDisk({
          disk: "files",
          contentTypes: rule.contentTypes,
          // Never build a key from the client's `originalname`.
          key: (file) => `${kind}/${randomUUID()}${file.extension}`,
        }),
        limits: rules.limitsFor(kind),
      };
      this.upload = multer(options);
    }

    async intercept(context: ExecutionContext, next: CallHandler) {
      const http = context.switchToHttp();
      const request = http.getRequest();
      const response = http.getResponse();
      const handler =
        mode === "single"
          ? this.upload.single(fieldName)
          : this.upload.array(fieldName);

      await new Promise<void>((resolve, reject) => {
        handler(request, response, (error: unknown) => {
          if (!error) {
            resolve();
            return;
          }
          // uploadToDisk already answers 415 for a type it cannot detect.
          if (error instanceof HttpException) {
            reject(error);
            return;
          }
          const code = (error as { code?: string }).code;
          if (code === "LIMIT_FILE_SIZE") {
            reject(new PayloadTooLargeException("File too large"));
            return;
          }
          reject(new BadRequestException("Invalid multipart request"));
        });
      });

      return next.handle();
    }
  }

  return ConfiguredUploadInterceptor;
}

export const AvatarFileInterceptor = configureInterceptor(
  "file",
  "single",
  "AVATAR",
);

export const ProfileCvFileInterceptor = configureInterceptor(
  "file",
  "single",
  "CV",
);

export const ListingImagesInterceptor = configureInterceptor(
  "images",
  "array",
  "LISTING_IMAGE",
);
