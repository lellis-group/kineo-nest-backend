import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client";
import type { FindReplacementListingsDto } from "./dto/find-replacementlistings.dto";

/**
 * Keyset ("cursor") pagination for the listing feeds.
 *
 * `skip` makes Postgres read and throw away every row before the page, so a
 * deep page costs as much as all the pages before it, and a posting inserted
 * while the reader pages shifts every later page by one: a row shown twice, or
 * never. Prisma's pagination guide recommends a cursor for both reasons. The
 * `rl_*_id_desc_idx` indexes already carry each ordering's keys with `id` as
 * the tiebreaker, so a cursor seeks straight to its place.
 *
 * The cursor carries the keys of the last row it was cut after, not only its
 * id: Prisma's own `cursor: { id }` re-reads that row to learn where to resume,
 * and a posting closed or deleted between two pages would end the walk. Keys
 * held by the client resume from where the row *was*, whatever became of it.
 */

export type ListingSort = NonNullable<FindReplacementListingsDto["sort"]>;

export interface ListingCursorKey {
  id: string;
  createdAt: Date;
  startDate: Date;
  urgent: boolean;
}

interface EncodedCursor {
  s: ListingSort;
  i: string;
  c: string;
  d: string;
  u: boolean;
}

export const INVALID_CURSOR_MESSAGE =
  "cursor is not valid for this ordering; start again without one";

/** The opaque token handed to the client after the last row of a page. */
export function encodeListingCursor(
  sort: ListingSort,
  row: ListingCursorKey,
): string {
  const payload: EncodedCursor = {
    s: sort,
    i: row.id,
    c: row.createdAt.toISOString(),
    d: row.startDate.toISOString(),
    u: row.urgent,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * The keys a token was cut after, or a 400.
 *
 * A token minted under one ordering is refused under another: its keys say
 * where a row sat in *that* ordering, and resuming a different one from them
 * would skip or repeat rows without a word.
 */
export function decodeListingCursor(
  token: string,
  sort: ListingSort,
): ListingCursorKey {
  let parsed: Partial<EncodedCursor>;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException(INVALID_CURSOR_MESSAGE);
  }

  const createdAt = new Date(parsed?.c ?? "");
  const startDate = new Date(parsed?.d ?? "");

  if (
    parsed?.s !== sort ||
    typeof parsed.i !== "string" ||
    parsed.i.length === 0 ||
    typeof parsed.u !== "boolean" ||
    Number.isNaN(createdAt.getTime()) ||
    Number.isNaN(startDate.getTime())
  ) {
    throw new BadRequestException(INVALID_CURSOR_MESSAGE);
  }

  return { id: parsed.i, createdAt, startDate, urgent: parsed.u };
}

/**
 * The rows that come after `key` in the order `orderByFor(sort)` describes.
 *
 * The mirror of `precedesInOrder`: every ordering ends on `id desc`, so on a
 * tie the rows that follow are the ones with a smaller id.
 */
export function followsInOrder(
  key: ListingCursorKey,
  sort: ListingSort,
): Prisma.ReplacementListingWhereInput {
  const laterStart: Prisma.ReplacementListingWhereInput = {
    OR: [
      { startDate: { gt: key.startDate } },
      { AND: [{ startDate: key.startDate }, { id: { lt: key.id } }] },
    ],
  };

  if (sort === "startDate") {
    return laterStart;
  }

  if (sort === "urgent") {
    // `urgent desc`: after an urgent posting come the later urgent ones and
    // then every non-urgent one; after a non-urgent one, only later
    // non-urgent ones.
    const sameUrgencyAfter = { AND: [{ urgent: key.urgent }, laterStart] };
    return key.urgent
      ? { OR: [{ urgent: false }, sameUrgencyAfter] }
      : sameUrgencyAfter;
  }

  return {
    OR: [
      { createdAt: { lt: key.createdAt } },
      { AND: [{ createdAt: key.createdAt }, { id: { lt: key.id } }] },
    ],
  };
}
