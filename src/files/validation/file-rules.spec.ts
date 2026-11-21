import { describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { FileRules } from "./file-rules";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, fallback: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function upload(buffer: Buffer, mimetype: string): Express.Multer.File {
  return {
    buffer,
    mimetype,
    size: buffer.length,
    originalname: "cv.pdf",
    fieldname: "file",
    encoding: "7bit",
    destination: "",
    filename: "",
    path: "",
    stream: null as never,
  };
}

describe("FileRules", () => {
  const rules = new FileRules(
    config({
      "files.limits.avatarBytes": 1024,
      "files.limits.imageBytes": 2048,
      "files.limits.imagesPerListing": 3,
      "files.limits.cvBytes": 4096,
    }),
  );

  it("reads every ceiling from configuration", () => {
    expect(rules.for("AVATAR").maxBytes).toBe(1024);
    expect(rules.for("LISTING_IMAGE").maxCount).toBe(3);
    expect(rules.for("CV").maxBytes).toBe(4096);
    expect(rules.limitsFor("LISTING_IMAGE")).toEqual({
      fileSize: 2048,
      files: 3,
    });
  });

  it("derives the extension from the detected MIME, not the filename", () => {
    expect(rules.extensionFor("image/png")).toBe(".png");
    expect(rules.extensionFor("image/jpeg")).toBe(".jpg");
    expect(rules.extensionFor("image/webp")).toBe(".webp");
    expect(rules.extensionFor("application/pdf")).toBe(".pdf");
    expect(rules.extensionFor("text/html")).toBe("");
  });

  it("strips path, control characters and quotes from a display name", () => {
    expect(rules.displayName('../evil\r\n"name".png')).toBe("evilname.png");
    expect(rules.displayName("../../")).toBe("file");
  });

  it("accepts a real PDF as a CV", async () => {
    const file = upload(MINIMAL_PDF, "application/pdf");
    await expect(rules.pipeFor("CV").transform(file)).resolves.toBe(file);
  });

  it("rejects a PNG sent as a CV even when the client says PDF", async () => {
    const file = upload(ONE_PIXEL_PNG, "application/pdf");
    await expect(rules.pipeFor("CV").transform(file)).rejects.toThrow();
  });

  it("rejects a file above the configured ceiling", async () => {
    const file = upload(Buffer.alloc(2049, 1), "image/png");
    file.mimetype = "image/png";
    await expect(
      rules.pipeFor("LISTING_IMAGE").transform(file),
    ).rejects.toThrow();
  });
});
