import {
  type ArgumentMetadata,
  Injectable,
  type ParseFilePipe,
  type PipeTransform,
} from "@nestjs/common";
import { FileRules, type UploadKind } from "./file-rules";

/** DI-friendly wrapper around `ParseFilePipe`, whose validators are config-driven. */
function configuredPipe(kind: UploadKind) {
  @Injectable()
  class ConfiguredFilePipe implements PipeTransform {
    private readonly delegate: ParseFilePipe;

    constructor(rules: FileRules) {
      this.delegate = rules.pipeFor(kind);
    }

    transform(value: unknown, _metadata: ArgumentMetadata) {
      return this.delegate.transform(value);
    }
  }

  return ConfiguredFilePipe;
}

export const AvatarFilePipe = configuredPipe("AVATAR");
export const ProfileCvFilePipe = configuredPipe("CV");
export const ListingImageFilePipe = configuredPipe("LISTING_IMAGE");
