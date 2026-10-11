import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { PaginationMetaSchema } from "../../common/pagination";
import { ListingStatus, Specialty } from "../../generated/prisma/enums";

/**
 * The practice a listing is attached to, reduced to what a reader of the public
 * feed can act on.
 *
 * A listing carried `practiceId` and nothing else, which made the practice
 * itself unreachable from the feed: a client had to ask `/practices` for a second
 * time and stitch the two answers together on `practiceId`, and could not place a
 * listing on a map at all because it had no coordinates. These are the fields the
 * browse screen actually renders — where the posting is, and under whose name.
 *
 * Deliberately not the whole `Practice` entity: `ownerId` and `createdAt` are not
 * the feed's business, and the address is a level of precision the feed does not
 * need on every row.
 */
export const PracticeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export const ReplacementListingSchema = z.object({
  id: z.string(),
  practiceId: z.string(),
  practice: PracticeSummarySchema,
  title: z.string(),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  specialty: z.enum(Specialty),
  status: z.enum(ListingStatus),
  urgent: z.boolean(),
  description: z.string().nullable(),
  maxApplications: z.number().nullable(),
  applicationsCount: z.number(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ReplacementListing extends createZodDto(
  ReplacementListingSchema,
) {}

/**
 * Totals per status, so the tabs on the owner's own listings can stay stable
 * across pages and filters. `total` backs the "all" tab.
 */
export const ListingStatusCountsSchema = z.object({
  total: z.number(),
  DRAFT: z.number(),
  OPEN: z.number(),
  IN_DISCUSSION: z.number(),
  FULL: z.number(),
  FILLED: z.number(),
  CLOSED: z.number(),
  CLOSED_NO_CANDIDATE: z.number(),
  CANCELLED: z.number(),
});

export const PaginatedReplacementListingsSchema = z.object({
  data: z.array(ReplacementListingSchema),
  meta: PaginationMetaSchema.extend({
    counts: ListingStatusCountsSchema.optional(),
  }),
});

export class PaginatedReplacementListings extends createZodDto(
  PaginatedReplacementListingsSchema,
) {}

/**
 * Counts the browse screen can draw a summary from, computed over the whole
 * matching collection rather than over the rows of one page.
 *
 * Every one of these numbers was, until this endpoint existed, unavailable: the
 * feed reports `meta.total` for the active filter and nothing else, so a client
 * wanting "how many urgent ones are there" or "how are they spread across
 * specialties" had no honest source. The only alternative was to aggregate the
 * current page — which produces a number that changes as the reader pages, and
 * is wrong beyond the first hundred rows.
 *
 * `bySpecialty` is the full enum rather than only the specialties present: the
 * screen draws one row per specialty in a fixed order, and a missing key would
 * render as an absent row rather than as a zero.
 */
export const ListingFacetsSchema = z.object({
  /** Open listings matching the filters, ignoring `specialty` itself. */
  total: z.number(),
  /** Of those, the ones flagged urgent. */
  urgent: z.number(),
  bySpecialty: z.record(z.enum(Specialty), z.number()),
});

export class ListingFacets extends createZodDto(ListingFacetsSchema) {}

/**
 * A place the map draws, with the postings that sit on it.
 *
 * A place, not a posting. The map feeds from the collection a filter selects,
 * and the endpoint paginates; a client reading the page to draw the map showed
 * a hundred postings' worth of practices and silently dropped the rest, with no
 * way to see the gap.
 *
 * `listings` is a preview, capped. `count` is the population and is what the
 * badge, the accessible label and the "+N others" line read — never the length
 * of the preview, which is a rendering convenience and not a fact.
 */
export type ListingPlace = z.infer<typeof ListingPlaceSchema>;

export const ListingPlaceSchema = z.object({
  practiceId: z.string(),
  name: z.string(),
  city: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  count: z.number(),
  listings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      // ISO, and formatted by the client: it already knows the reader's locale,
      // and a second French sentence written server-side would be a second
      // place for them to disagree.
      startDate: z.iso.datetime(),
      endDate: z.iso.datetime(),
    }),
  ),
});

export const ListingPlacesSchema = z.object({
  places: z.array(ListingPlaceSchema),

  /**
   * Every matching posting's id, in the ordering the reader asked for.
   *
   * The reader can pick a posting from any popup, including one the list is not
   * currently showing, and the list has to turn to the page that holds it. That
   * needs the position of the posting in the filtered collection, which the
   * previews cannot answer: the places are ordered by population and each holds
   * four of its own.
   */
  listingIds: z.array(z.string()),

  /** Matching postings whose practice was never geocoded. */
  unlocated: z.number(),

  /** How many places the filters actually matched, before the ceiling. */
  totalPlaces: z.number(),

  /**
   * True when `places` was cut at the ceiling.
   *
   * Paired with `totalPlaces` so the client can say how many are missing rather
   * than only that some are. A flag with no count is a flag nothing can render:
   * "there are more" invites the reader to look for what.
   */
  truncated: z.boolean(),
});

export class ListingPlaces extends createZodDto(ListingPlacesSchema) {}
