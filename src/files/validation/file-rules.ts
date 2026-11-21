import { basename } from "node:path";
import {
  FileTypeValidator,
  HttpStatus,
  Injectable,
  MaxFileSizeValidator,
  type ParseFilePipe,
  ParseFilePipeBuilder,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type UploadKind = "AVATAR" | "LISTING_IMAGE" | "CV";

export interface UploadRule {
  maxBytes: number;
  maxCount: number;
  /** Matched against the MIME detected from magic numbers, not the client header. */
  fileType: RegExp;
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;

/** Extensions are derived from the detected MIME, never from `originalname`. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

/**
 * The single place where per-kind upload limits live.
 *
 * Both halves matter: `limits.fileSize` makes Multer stop writing an oversized
 * part as soon as it crosses the ceiling, while the validators below inspect the
 * completed buffer (including its magic number) before the handler runs.
 */
@Injectable()
export class FileRules {
  private readonly rules: Record<UploadKind, UploadRule>;

  constructor(config: ConfigService) {
    this.rules = {
      AVATAR: {
        maxBytes: config.get<number>(
          "files.limits.avatarBytes",
          2 * 1024 * 1024,
        ),
        maxCount: 1,
        fileType: IMAGE_TYPES,
      },
      LISTING_IMAGE: {
        maxBytes: config.get<number>(
          "files.limits.imageBytes",
          5 * 1024 * 1024,
        ),
        maxCount: config.get<number>("files.limits.imagesPerListing", 5),
        fileType: IMAGE_TYPES,
      },
      CV: {
        maxBytes: config.get<number>("files.limits.cvBytes", 10 * 1024 * 1024),
        maxCount: 1,
        fileType: /^application\/pdf$/,
      },
    };
  }

  for(kind: UploadKind): UploadRule {
    return this.rules[kind];
  }

  /** Multer's early-rejection limit for a route. */
  limitsFor(kind: UploadKind): { fileSize: number; files: number } {
    const rule = this.rules[kind];
    return { fileSize: rule.maxBytes, files: rule.maxCount };
  }

  pipeFor(kind: UploadKind): ParseFilePipe {
    const rule = this.rules[kind];
    return new ParseFilePipeBuilder()
      .addMaxSizeValidator({ maxSize: rule.maxBytes })
      .addFileTypeValidator({
        fileType: rule.fileType,
        // The detected type, not the client's `mimetype`, is what gets stored.
        overrideMimeType: true,
      })
      .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });
  }

  extensionFor(mimeType: string): string {
    return EXTENSIONS[mimeType] ?? "";
  }

  /** A safe basename for `Content-Disposition`, capped in length. */
  displayName(originalName: string): string {
    const name = basename(originalName)
      // Control characters (including CR/LF) must never reach a response header.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/["\\]/g, "")
      .trim();
    // `basename("../../")` is `".."`, which is not a usable filename either.
    if (name.length === 0 || /^\.+$/.test(name)) return "file";
    return name.slice(0, 200);
  }
}

// Re-exported so a single import serves both the builder and direct validators
// in tests.
export { FileTypeValidator, MaxFileSizeValidator };
