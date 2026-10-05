import { z } from "zod";

/**
 * Pagination, written once.
 *
 * Four query DTOs carried the same two fields and the same ceiling rule, with the
 * same description strings and the same error sentence written out four times.
 * Six services then re-derived `skip` from them, and seven places built the `meta`
 * object the response returns.
 *
 * `MAX_RESULTS` is the part that mattered: it exists so a client cannot ask the
 * database for a million rows by asking for a small `limit` at a high `page`, and
 * a copy that drifted would have quietly removed that bound for one resource.
 */
export const MAX_RESULTS = 10_000;

/** `"page and limit combination is too large…"` — one sentence, four DTOs. */
export const PAGINATION_TOO_LARGE_MESSAGE = `page and limit combination is too large (no more than ${MAX_RESULTS.toLocaleString("en-US")} results can be requested)`;

/**
 * The two fields to spread into a query schema.
 *
 * Spread rather than extended so a DTO keeps declaring its own object — the
 * `.strict()` that rejects an unknown key is the point of these schemas.
 */
export const paginationQueryShape = {
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1)
    .describe("Page number, starting at 1"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of results per page, max 100"),
};

/** The bound, as a zod refinement — for the schemas that take `page`/`limit`. */
export function paginationWithinBounds(data: {
  page?: number;
  limit?: number;
}): boolean {
  // Both are defaulted by the schema, so the fallbacks here are only reached if a
  // service calls the parser without one of them.
  const page = data.page ?? 1;
  const limit = data.limit ?? 20;
  return page * limit <= MAX_RESULTS;
}

/** The same refinement, ready to attach. */
export const paginationBoundsRefine = {
  message: PAGINATION_TOO_LARGE_MESSAGE,
  path: ["page"],
};

/**
 * `skip`/`limit` from a parsed query, and the `meta` the response carries.
 *
 * Six services each did `page = filters.page ?? 1; limit = filters.limit ?? 20;
 * skip = (page - 1) * limit` and then `totalPages: Math.ceil(total / limit)`.
 * The `??` is dead over HTTP — the schema defaults both — but it is the only
 * guard if a service is called directly, which the unit specs do.
 */
export function paginate(filters: { page?: number; limit?: number }): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  return { page, limit, skip: (page - 1) * limit };
}

/** The pagination half of a response's `meta`. */
export function paginationMeta(
  total: number,
  page: number,
  limit: number,
): {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
} {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/**
 * The pagination half of a response's `meta`, as a zod object.
 *
 * Four entity schemas declared `total`/`page`/`limit`/`totalPages` by hand, so a
 * field the services grew would have had to be added four times — and a field
 * dropped from the response would still have been accepted by all four.
 */
export const PaginationMetaSchema = z.object({
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});
