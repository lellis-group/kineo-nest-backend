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
  const settings = config.getOrThrow<StorageSettings>("storage");
  const nodeEnv = config.getOrThrow<string>("nodeEnv");

  if (settings.driver === "local") {
    // The package only warns about this. A container's local disk disappears
    // with the task and other replicas cannot read it, so a deployment must
    // fail here instead of starting on a disk it cannot keep.
    if (isHardenedEnv(nodeEnv)) {
      throw new Error(
        "STORAGE_DRIVER=local is not allowed in a hardened environment",
      );
    }
    return {
      default: "files",
      disks: {
        files: new LocalDisk({
          root: join(process.cwd(), config.getOrThrow<string>("storage.root")),
        }),
      },
    };
  }

  if (settings.driver !== "s3") {
    throw new Error(`Unknown STORAGE_DRIVER: ${settings.driver}`);
  }

  const { s3 } = settings;
  if (!s3.bucket) {
    throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  if (!s3.endpoint) {
    throw new Error("S3_ENDPOINT is required when STORAGE_DRIVER=s3");
  }
  // The fallback pair exists so a fresh checkout can talk to compose's RustFS.
  // It must never reach a deployed environment.
  if (
    isHardenedEnv(nodeEnv) &&
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
