import { z } from "zod";
import { createZodDto } from "../../common/zod-dto";

/**
 * The body `/health` answers with.
 *
 * One shape for both depths, where the deep probe is a superset: the shallow
 * probe answers `{ status: "ok" }` and nothing else, and `?deep=1` adds when it
 * asked, for how long the process has been up, and what the database check said.
 * Modelled as optional rather than two schemas so the reader of the document
 * meets one shape — the ones that distinguish them are the query parameter and
 * the 401 it can cost, not the body.
 */
export const HealthSchema = z.object({
  status: z.literal("ok").describe("The process answered"),
  timestamp: z.iso.datetime().optional().describe("Deep probe only"),
  uptime: z.number().optional().describe("Seconds since boot, deep probe only"),
  database: z
    .literal("connected")
    .optional()
    .describe("After a SELECT 1 answered, deep probe only"),
});

export class Health extends createZodDto(HealthSchema) {}
