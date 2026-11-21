/**
 * One-shot bucket bootstrap for an S3-compatible store (RustFS, MinIO, S3).
 *
 * `@nestjs/storage` deliberately does not create buckets: that is an operator
 * concern, not something the API should do on every boot. This script sends a
 * single signed `PUT /<bucket>` (idempotent — an existing bucket answers 200)
 * using the same SigV4 rules the disk uses, so no extra dependency or image is
 * needed.
 */

import { createHash, createHmac } from "node:crypto";

const endpoint = (process.env.S3_ENDPOINT ?? "http://localhost:9000").replace(
  /\/+$/,
  "",
);
const bucket = process.env.S3_BUCKET ?? "kineo-files";
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;

if (!accessKeyId || !secretAccessKey) {
  throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY are required");
}

const url = new URL(`${endpoint}/${bucket}`);
const region = process.env.S3_REGION ?? "us-east-1";
const service = "s3";
const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
const dateStamp = amzDate.slice(0, 8);
const payloadHash = createHash("sha256").update("").digest("hex");

const canonicalHeaders =
  `host:${url.host}\n` +
  `x-amz-content-sha256:${payloadHash}\n` +
  `x-amz-date:${amzDate}\n`;
const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
const canonicalRequest = [
  "PUT",
  url.pathname,
  "",
  canonicalHeaders,
  signedHeaders,
  payloadHash,
].join("\n");
const scope = `${dateStamp}/${region}/${service}/aws4_request`;
const stringToSign = [
  "AWS4-HMAC-SHA256",
  amzDate,
  scope,
  createHash("sha256").update(canonicalRequest).digest("hex"),
].join("\n");

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const signingKey = hmac(
  hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
  "aws4_request",
);
const signature = createHmac("sha256", signingKey)
  .update(stringToSign)
  .digest("hex");

const response = await fetch(url, {
  method: "PUT",
  headers: {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  },
});

if (!response.ok) {
  throw new Error(
    `Bucket creation failed (${response.status}): ${await response.text()}`,
  );
}
console.log(`Bucket ${bucket} is ready at ${url}`);
