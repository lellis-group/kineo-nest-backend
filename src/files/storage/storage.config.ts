import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { LocalDisk, S3Disk, type StorageModuleOptions } from "@nestjs/storage";
import { isHardenedEnv } from "../../config/env";

interface StorageSettings {
  driver: string;
  root: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * The one place that knows which `@nestjs/storage` disk backs the files.
 *
 * Changing `STORAGE_DRIVER` switches between a local folder and RustFS without
 * touching a service, controller, route or database row: every caller deals in
 * storage keys through the `StorageDisk` contract.
 */
export function createStorageOptions(
  config: ConfigService,
): StorageModuleOptions {
  const settings = config.get<StorageSettings>("storage");
  if (!settings) {
    throw new Error("Missing file storage configuration (storage)");
  }

  if (settings.driver === "local") {
    return {
      default: "files",
      disks: {
        files: new LocalDisk({ root: join(process.cwd(), settings.root) }),
      },
    };
  }

  if (settings.driver !== "s3") {
    throw new Error(`Unknown STORAGE_DRIVER: ${settings.driver}`);
  }

  const { s3 } = settings;
  // The fallback pair exists so a fresh checkout can talk to compose's RustFS.
  // It must never reach a deployed environment.
  if (
    isHardenedEnv(config.get<string>("nodeEnv")) &&
    (s3.accessKeyId === "kineolocal" || s3.secretAccessKey === "kineolocal")
  ) {
    throw new Error(
      "S3_ACCESS_KEY and S3_SECRET_KEY are required in a hardened environment",
    );
  }

  return {
    default: "files",
    disks: {
      files: new S3Disk({
        bucket: s3.bucket,
        endpoint: s3.endpoint,
        region: s3.region,
        forcePathStyle: s3.forcePathStyle,
        credentials: {
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
        },
      }),
    },
  };
}
