import { basename } from "node:path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type UploadKind = "AVATAR" | "LISTING_IMAGE" | "CV";

export interface UploadRule {
  maxBytes: number;
  maxCount: number;
  /** Passed to `uploadToDisk`, which matches the type detected from the bytes. */
  contentTypes: string[];
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * The single place where per-kind upload rules live.
 *
 * Both halves are enforced by Multer before the handler runs: `limits.fileSize`
 * stops an oversized part as soon as it crosses the ceiling, and
 * `uploadToDisk()` refuses a type it cannot detect in `contentTypes` with a 415
 * before a single byte is committed.
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
        contentTypes: IMAGE_TYPES,
      },
      LISTING_IMAGE: {
        maxBytes: config.get<number>(
          "files.limits.imageBytes",
          5 * 1024 * 1024,
        ),
        maxCount: config.get<number>("files.limits.imagesPerListing", 5),
        contentTypes: IMAGE_TYPES,
      },
      CV: {
        maxBytes: config.get<number>("files.limits.cvBytes", 10 * 1024 * 1024),
        maxCount: 1,
        contentTypes: ["application/pdf"],
      },
    };
  }

  for(kind: UploadKind): UploadRule {
    return this.rules[kind];
  }

  /** Multer's early-rejection limits for a route. */
  limitsFor(kind: UploadKind): { fileSize: number; files: number } {
    const rule = this.rules[kind];
    return { fileSize: rule.maxBytes, files: rule.maxCount };
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
