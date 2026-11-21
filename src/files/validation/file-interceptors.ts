import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import multer, { memoryStorage, type Options } from "multer";
import { FileRules } from "./file-rules";

/**
 * Multer interceptors whose limits come from configuration at construction time.
 *
 * Nest's `FileInterceptor` takes its options as a decorator argument, which is
 * evaluated before DI exists. These classes take `FileRules` through the
 * constructor instead, so the ceilings in `.env` actually bound the parser
 * rather than only the validators that run afterwards.
 */
function configureInterceptor(
  fieldName: string,
  mode: "single" | "array",
  configure: (rules: FileRules) => Options,
) {
  @Injectable()
  class ConfiguredUploadInterceptor implements NestInterceptor {
    private readonly upload: multer.Multer;

    constructor(rules: FileRules) {
      this.upload = multer({ storage: memoryStorage(), ...configure(rules) });
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
  (rules) => ({ limits: rules.limitsFor("AVATAR") }),
);

export const ProfileCvFileInterceptor = configureInterceptor(
  "file",
  "single",
  (rules) => ({ limits: rules.limitsFor("CV") }),
);

export const ListingImagesInterceptor = configureInterceptor(
  "images",
  "array",
  (rules) => ({ limits: rules.limitsFor("LISTING_IMAGE") }),
);
