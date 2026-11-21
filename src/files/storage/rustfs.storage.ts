import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isHardenedEnv } from "../../config/env";
import { logError, logEvent } from "../../lib/log";
import type { FileStorage, StoredObject } from "./file-storage";

interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

function isMissingBucket(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  const status = (
    error as { $metadata?: { httpStatusCode?: number } } | undefined
  )?.$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchBucket" || status === 404;
}

/**
 * S3-backed storage pointed at RustFS.
 *
 * Bucket provisioning is best-effort at boot: a missing bucket is created, but an
 * unreachable server only logs. Booting the API must not depend on an external
 * container being up — uploads simply fail until it is, and health checks stay
 * the deployment's business.
 */
@Injectable()
export class RustFsStorage implements FileStorage, OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const s3 = config.get<S3Settings>("files.s3");
    if (!s3) {
      throw new Error("Missing file storage configuration (files.s3)");
    }
    // The fallback pair exists so a fresh checkout can talk to compose's
    // RustFS. It must never reach a deployed environment.
    if (
      isHardenedEnv(config.get<string>("nodeEnv")) &&
      (s3.accessKeyId === "kineolocal" || s3.secretAccessKey === "kineolocal")
    ) {
      throw new Error(
        "FILES_S3_ACCESS_KEY and FILES_S3_SECRET_KEY are required in a hardened environment",
      );
    }

    this.bucket = s3.bucket;
    this.client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isMissingBucket(error)) {
        logError("files.bucket.check_failed", error, { bucket: this.bucket });
        return;
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      logEvent("files.bucket.created", { bucket: this.bucket });
    } catch (error) {
      logError("files.bucket.create_failed", error, { bucket: this.bucket });
    }
  }

  async save(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async open(key: string): Promise<StoredObject> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!result.Body) {
      throw new Error(`Stored object ${key} has no body`);
    }

    return {
      body: result.Body as Readable,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
    };
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async list() {
    const objects: { key: string; lastModified: Date }[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified) {
          objects.push({ key: item.Key, lastModified: item.LastModified });
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return objects;
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    // S3's CopySource is a URI: encode the bucket and each path segment so a
    // key containing spaces or reserved characters cannot break the header.
    const source = `/${encodeURIComponent(this.bucket)}/${sourceKey
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: source,
      }),
    );
  }
}
