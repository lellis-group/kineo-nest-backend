import compression from "compression";
import type { Request, Response } from "express";

/**
 * Whether a response may be compressed.
 *
 * BREACH: a compressed response that reflects something the caller chose can be
 * cracked from the length of the answers alone, one byte at a time. The only place
 * this API reflects caller input back is an error body — a refusal names the field
 * that was wrong — so those are served uncompressed. Everything else keeps the
 * library's own decision.
 */
export function compressionFilter(req: Request, res: Response): boolean {
  const contentType = res.getHeader("content-type");

  if (
    res.statusCode >= 400 &&
    typeof contentType === "string" &&
    contentType.startsWith("application/json")
  ) {
    return false;
  }

  return compression.filter(req, res);
}
