import { describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { LocalDisk, S3Disk } from "@nestjs/storage";
import { createStorageOptions } from "./storage.config";

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      let value = values[key];
      if (value === undefined && key.startsWith("storage.")) {
        value = (values.storage as Record<string, unknown> | undefined)?.[
          key.slice("storage.".length)
        ];
      }
      if (value === undefined) throw new Error(`Missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

const s3 = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "kineo-files",
  forcePathStyle: true,
  accessKeyId: "kineolocal",
  secretAccessKey: "kineolocal",
};

describe("createStorageOptions", () => {
  it("builds a local disk in development", () => {
    const options = createStorageOptions(
      config({
        nodeEnv: "development",
        storage: { driver: "local", root: "storage", s3 },
      }),
    );

    expect(options.default).toBe("files");
    expect(options.disks?.files).toBeInstanceOf(LocalDisk);
  });

  it("builds an S3 disk for RustFS", () => {
    const options = createStorageOptions(
      config({
        nodeEnv: "development",
        storage: { driver: "s3", root: "storage", s3 },
      }),
    );

    expect(options.disks?.files).toBeInstanceOf(S3Disk);
  });

  it("refuses an unknown driver", () => {
    expect(() =>
      createStorageOptions(
        config({
          nodeEnv: "development",
          storage: { driver: "ftp", root: "storage", s3 },
        }),
      ),
    ).toThrow(/Unknown STORAGE_DRIVER/);
  });

  it("refuses a local disk in a hardened environment", () => {
    expect(() =>
      createStorageOptions(
        config({
          nodeEnv: "production",
          storage: { driver: "local", root: "storage", s3 },
        }),
      ),
    ).toThrow(/not allowed in a hardened environment/);
  });

  it("refuses the development S3 credentials in a hardened environment", () => {
    expect(() =>
      createStorageOptions(
        config({
          nodeEnv: "production",
          storage: { driver: "s3", root: "storage", s3 },
        }),
      ),
    ).toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY are required/);
  });
});
