import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PLATFORM_REJECTION_REASONS } from "../applications/rejection-reasons";
import {
  assertNoThirdPartyApplications,
  LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
} from "../common/application-guard";
import {
  ACTIVE_APPLICATION_STATUSES,
  IN_PLAY_LISTING_STATUSES,
  isTerminalListingStatus,
  MANUAL_LISTING_STATUSES,
  RECRUITING_LISTING_STATUSES,
  recalcListingStatus,
} from "../common/listing-status";
import { paginate, paginationMeta } from "../common/pagination";
import {
  getOwnedProfileId,
  getOwnedProfileIdSafe,
} from "../common/profile-lookup";
import { REFUSAL_CODES, refusal } from "../common/refusal";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { Prisma } from "../generated/prisma/client";
import type { ListingStatus } from "../generated/prisma/enums";
import {
  ListingStatus as LISTING_STATUSES,
  Specialty,
} from "../generated/prisma/enums";
import { PrismaService } from "../prisma.service";
import { PLACE_PREVIEW_LIMIT } from "./browse";
import type { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import {
  type FindPageOfDto,
  type FindPlacesDto,
  type FindReplacementListingsDto,
} from "./dto/find-replacementlistings.dto";
import type { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
import type { ListingPlace } from "./entities/replacementlisting.entity";
import { toReplacementListingDto } from "./replacementlisting.mapper";

/**
 * Settles every active application on a listing the platform is taking out of
 * circulation, on behalf of the owner who closed or cancelled it.
 *
 * One function because `close` and `cancel` were doing this inline, side by side
 * and one field apart: `close` recorded who had decided, `cancel` did not, so a
 * cancellation left `decisionSource` NULL and an audit reading "who decided this"
 * answered differently for two ways of ending the same listing. The reason is the
 * only thing that differs between them, so it is the only thing passed in.
 */
async function rejectActiveApplicationsOnListing(
  client: PrismaService | Prisma.TransactionClient,
  listingId: string,
  reason: string,
  at: Date,
): Promise<void> {
  await client.application.updateMany({
    where: { listingId, status: { in: ACTIVE_APPLICATION_STATUSES } },
    data: {
      status: "REJECTED",
      decisionSource: "PRACTICE_REJECTED",
      rejectionReason: reason,
      respondedAt: at,
    },
  });
}

// A listing in one of these still counts against the owner's quota: a draft
// and a filled listing are both work in progress that has to be dealt with.
const ACTIVE_LISTING_STATUSES: ListingStatus[] = RECRUITING_LISTING_STATUSES;

const APPLICATIONS_COUNT_INCLUDE = {
  _count: {
    select: {
      applications: { where: { status: { in: ACTIVE_APPLICATION_STATUSES } } },
    },
  },
};

/**
 * The application counts for a page of listings, counted per listing.
 *
 * The obvious way to attach a count to a read is Prisma's `_count`, and it is
 * what this used. What Prisma compiles it to is a LEFT JOIN over a
 * sub-aggregate, and the aggregate has no idea which listings were asked for: a
 * page of ten postings counted every application on every listing in the table
 * — 3 006 rows scanned and 1 600 hashed, to return ten numbers. On the seeded
 * corpus that was 3.5 ms of execution and 6.4 ms of wall, against 0.09 ms and
 * 1.3 ms for the same question asked about the ten ids on the page, and it grew
 * with the table rather than with the page.
 *
 * An index cannot fix this one, which is why it is a code change and not a
 * migration: the count's predicate is parameterised, and Postgres will not match
 * a partial index against a parameterised predicate. Every candidate index
 * tested against this shape was ignored. The only fix that scales is to stop
 * counting what nobody asked for.
 *
 * What is counted is unchanged: `ACTIVE_APPLICATION_STATUSES`, PENDING and
 * SHORTLISTED, the same predicate as before. Only the scope of the count moved,
 * from the whole table to the page — which is the scope the number has always
 * been read for.
 */
async function countApplicationsPerListing(
  client: PrismaService | Prisma.TransactionClient,
  listingIds: string[],
): Promise<Map<string, number>> {
  if (listingIds.length === 0) {
    return new Map();
  }

  const grouped = await client.application.groupBy({
    by: ["listingId"],
    where: {
      listingId: { in: listingIds },
      status: { in: ACTIVE_APPLICATION_STATUSES },
    },
    _count: true,
  });

  return new Map(grouped.map((row) => [row.listingId, row._count]));
}

/**
 * The rows that come before one posting, in the order `orderByFor` describes.
 *
 * The map's popup can name a posting the list is not showing, and the list has
 * to turn to the page that holds it. That is a position in the reader's
 * ordering, which used to travel with every map read as the id of *every*
 * matching posting — 23 kB on the seeded corpus, and an O(n) read, paid on every
 * page render and every filter change, so that a rare click could do an
 * `indexOf` in the browser. It is now asked for when the click happens, and this
 * is the half of that question the database answers.
 *
 * Written out per sort rather than derived from `orderByFor`, because the orders
 * are not all the same shape. `urgent` sorts a boolean descending and then two
 * more keys, which is a three-level comparison with a level that has no "greater"
 * at all — a list of key comparisons cannot express it, and a clever derivation
 * would be a thing to read twice. Every sort that mixes ascending and
 * descending is spelled here; the spellings are pinned by a test that sorts a
 * corpus in memory with `orderByFor` and checks this predicate agrees.
 *
 * `id` is `desc` in every ordering, which is why the tiebreaker is always
 * `gt`: two rows can share `createdAt` or `startDate`, and the reader has to land
 * on the page that actually holds the one they picked.
 */
export function precedesInOrder(
  target: { id: string; createdAt: Date; startDate: Date; urgent: boolean },
  sort: FindReplacementListingsDto["sort"],
): Prisma.ReplacementListingWhereInput {
  const aheadOnId = {
    AND: [{ startDate: target.startDate }, { id: { gt: target.id } }],
  };

  if (sort === "startDate") {
    return {
      OR: [
        { startDate: { lt: target.startDate } },
        { AND: [{ startDate: target.startDate }, { id: { gt: target.id } }] },
      ],
    };
  }

  if (sort === "urgent") {
    // `urgent desc`: a boolean has nothing above `true`. So the postings that
    // outrank an urgent one are only the ones that start earlier, and the ones
    // that outrank a non-urgent one are every urgent posting *and* those.
    const sameUrgencyAhead = {
      AND: [
        { urgent: target.urgent },
        {
          OR: [{ startDate: { lt: target.startDate } }, aheadOnId],
        },
      ],
    };

    return target.urgent
      ? sameUrgencyAhead
      : { OR: [{ urgent: true }, sameUrgencyAhead] };
  }

  return {
    OR: [
      { createdAt: { gt: target.createdAt } },
      { AND: [{ createdAt: target.createdAt }, { id: { gt: target.id } }] },
    ],
  };
}

/**
 * The practice, reduced to what the listing DTO publishes.
 *
 * `isPublic` is not selected because it is enforced in the `where` clause
 * instead: a practice that went private has no business being readable through a
 * listing, and the feed is anonymous. Filtering rather than blanking the field
 * is deliberate — hiding the name but still listing the posting would still say
 * "there is a replacement posting in this town", which is the disclosure
 * `isPublic` exists to prevent. This matches what `GET /practices` already does.
 */
const PRACTICE_INCLUDE = {
  practice: {
    select: {
      id: true,
      name: true,
      city: true,
      latitude: true,
      longitude: true,
    },
  },
};

/** What a place read needs of a practice — position and nothing else. */
const PRACTICE_PLACES_SELECT = {
  id: true,
  name: true,
  city: true,
  latitude: true,
  longitude: true,
} as const;

/** What a place's preview needs of a posting. */
type PreviewListing = {
  id: string;
  practiceId: string;
  title: string;
  startDate: Date;
  endDate: Date;
};

const PLACE_LISTING_SELECT = {
  id: true,
  practiceId: true,
  title: true,
  startDate: true,
  endDate: true,
} as const;

/**
 * Pairs each place with its previews, capped.
 *
 * The cap is on the preview, never on `count`: the population comes from the
 * aggregate and is what the consumer reports. Taking four of a place with
 * nine is a rendering choice, and the aggregation already knows the nine.
 *
 * The previews are grouped once, by practice, before the map over the places.
 * Filtering them per place — the obvious shape — is quadratic in the two
 * collections, and `ranked` here is whatever survived the cap, so the cost grew
 * with the response rather than staying bounded by it.
 */
function assemblePlaces(
  practices: Array<{
    id: string;
    name: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
  }>,
  ranked: Array<{ practiceId: string; count: number }>,
  previews: PreviewListing[],
): ListingPlace[] {
  const byPractice = new Map(practices.map((p) => [p.id, p]));

  const previewsByPractice = new Map<string, PreviewListing[]>();
  for (const preview of previews) {
    const own = previewsByPractice.get(preview.practiceId);
    if (own) {
      own.push(preview);
    } else {
      previewsByPractice.set(preview.practiceId, [preview]);
    }
  }

  return ranked.map((place) => {
    const practice = byPractice.get(place.practiceId);
    const own = previewsByPractice.get(place.practiceId) ?? [];

    return {
      practiceId: place.practiceId,
      name: practice?.name ?? "",
      city: practice?.city ?? "",
      latitude: practice?.latitude ?? null,
      longitude: practice?.longitude ?? null,
      count: place.count,
      listings: own.slice(0, PLACE_PREVIEW_LIMIT).map((listing) => ({
        id: listing.id,
        title: listing.title,
        startDate: listing.startDate.toISOString(),
        endDate: listing.endDate.toISOString(),
      })),
    };
  });
}

/** Every include a listing read needs, in one place. */
const LISTING_INCLUDE = {
  ...APPLICATIONS_COUNT_INCLUDE,
  ...PRACTICE_INCLUDE,
};

/**
 * The same read, narrowed to what a feed publishes.
 *
 * `select` rather than `include`, because the feed is the one read that knows
 * exactly which columns it needs — and two things are not among them:
 * `description`, which no row and no card on the browse screen draws and which
 * was most of a page's payload on the seeded corpus, and `createdById`, which
 * is not in the DTO and only served to be stripped by zod after the database had
 * read it.
 *
 * No `_count` either: the application count comes from
 * `countApplicationsPerListing`, asked for the page rather than for the table.
 */
const LISTING_SUMMARY_SELECT = {
  id: true,
  practiceId: true,
  title: true,
  startDate: true,
  endDate: true,
  specialty: true,
  status: true,
  urgent: true,
  maxApplications: true,
  createdAt: true,
  updatedAt: true,
  ...PRACTICE_INCLUDE,
} as const;

/**
 * The ordering of a read, as a total one.
 *
 * `id` last, always. `createdAt` is not unique, so ordering by it alone leaves
 * Postgres free to return two rows in either order between two pages: offset
 * pagination then repeats one and skips the other.
 */
export function orderByFor(
  sort?: FindReplacementListingsDto["sort"],
): Prisma.ReplacementListingOrderByWithRelationInput[] {
  const id: Prisma.ReplacementListingOrderByWithRelationInput = {
    id: "desc",
  };

  if (sort === "startDate") {
    return [{ startDate: "asc" }, id];
  }
  if (sort === "urgent") {
    return [{ urgent: "desc" }, { startDate: "asc" }, id];
  }
  return [{ createdAt: "desc" }, id];
}

@Injectable()
export class ReplacementlistingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `_count` as `applicationsCount`, for a read that carried its own count.
   *
   * Kept beside `withCountFor` so the two spellings of the same number are
   * defined in one place: a listing read through Prisma's aggregate and a
   * listing read through the per-page count. A test that sees one and not the
   * other is the way this would otherwise drift.
   */
  private withCount<T extends { _count: { applications: number } }>(
    listing: T,
  ) {
    const { _count, ...rest } = listing;
    return { ...rest, applicationsCount: _count.applications };
  }

  /**
   * `applicationsCount` from the per-page aggregate.
   *
   * A listing with no application at all is simply absent from the grouping —
   * `groupBy` returns rows only where there is something to count — so the
   * lookup's miss is a zero, not a missing field. That is the same answer the
   * `_count` join produced for such a listing, which is why the two can share
   * the DTO.
   */
  private withCountFor<T extends { id: string }>(
    listing: T,
    counts: Map<string, number>,
  ): T & { applicationsCount: number } {
    return { ...listing, applicationsCount: counts.get(listing.id) ?? 0 };
  }

  async create(userId: string, dto: CreateReplacementListingDto) {
    const profileId = await getOwnedProfileId(this.prisma, userId);
    const maxListings = this.config.get<number>(
      "limits.activeListingsPerProfile",
    );
    const listing = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const practice = await tx.practice.findUnique({
          where: { id: dto.practiceId },
        });
        if (!practice) {
          throw new NotFoundException(`Practice ${dto.practiceId} not found`);
        }
        if (practice.ownerId !== profileId) {
          throw new ForbiddenException("You do not own this practice");
        }

        if (maxListings) {
          const count = await tx.replacementListing.count({
            where: {
              createdById: profileId,
              status: { in: ACTIVE_LISTING_STATUSES },
            },
          });
          if (count >= maxListings) {
            throw refusal(
              REFUSAL_CODES.listingQuotaReached,
              `You cannot have more than ${maxListings} active listings`,
            );
          }
        }

        return tx.replacementListing.create({
          data: {
            practiceId: dto.practiceId,
            createdById: profileId,
            title: dto.title,
            startDate: new Date(dto.startDate),
            endDate: new Date(dto.endDate),
            specialty: dto.specialty,
            urgent: dto.urgent ?? false,
            description: dto.description,
            maxApplications: dto.maxApplications,
          },
        });
      },
    );

    return toReplacementListingDto({ ...listing, applicationsCount: 0 });
  }

  /**
   * The predicate every listing read shares.
   *
   * `publicOnly` narrows to practices that are publicly listed. It merges into
   * the same `practice` key the `city` filter uses rather than sitting beside
   * it: two keys named `practice` in one object would have the second silently
   * replace the first, and the feed would quietly stop filtering by city — or
   * stop hiding private practices, depending on the order.
   */
  private buildListingsWhere(
    filters: Pick<
      FindReplacementListingsDto,
      | "status"
      | "specialty"
      | "city"
      | "urgent"
      | "startDateFrom"
      | "startDateTo"
      | "q"
    >,
    options: { publicOnly?: boolean } = {},
  ) {
    const practice: Prisma.PracticeWhereInput = {
      ...(filters.city
        ? { city: { contains: filters.city, mode: "insensitive" } }
        : {}),
      ...(options.publicOnly ? { isPublic: true } : {}),
    };

    return {
      status: filters.status,
      specialty: filters.specialty,
      urgent: filters.urgent,
      // Free-text, matched against the posting's own words rather than the
      // practice's city: a reader typing « dermatologue » or « mi-temps » is
      // naming the work, not a place. An `OR` over title and description, each
      // a case-insensitive `contains`, so a term in either field matches — and
      // omitted entirely when unset, since an empty `OR` would match nothing.
      //
      // No trigram index backs it: measured with `bun run profile`, the `ILIKE`
      // costs ~10–19 ms at the product corpus (~2.2k OPEN) and only becomes
      // visible around 14k rows, where a GIN index cut the places read from
      // 139 ms to 53 ms (the feed's from 42 ms to 23 ms). The index costs
      // ~1.7 MB and taxes writes, so it waits for the corpus to get there.
      ...(filters.q
        ? {
            OR: [
              { title: { contains: filters.q, mode: "insensitive" as const } },
              {
                description: {
                  contains: filters.q,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
      startDate:
        filters.startDateFrom || filters.startDateTo
          ? {
              gte: filters.startDateFrom
                ? new Date(filters.startDateFrom)
                : undefined,
              lte: filters.startDateTo
                ? new Date(filters.startDateTo)
                : undefined,
            }
          : undefined,
      // Left out entirely rather than set to `{}`, which Prisma reads as "match
      // every practice" and which would make the unfiltered reads scan the
      // relation instead of skipping it.
      ...(Object.keys(practice).length > 0 ? { practice } : {}),
    };
  }

  async findAll(filters: FindReplacementListingsDto) {
    const { page, limit, skip } = paginate(filters);
    // The public feed is OPEN whatever the caller asked for: a status filter on
    // a listing somebody else owns would turn the feed into a way to read the
    // statuses of postings still in circulation.
    const { status: _statusFilter, ...publicFilters } = filters;
    const where: Prisma.ReplacementListingWhereInput = {
      ...this.buildListingsWhere(publicFilters, { publicOnly: true }),
      status: "OPEN",
    };

    const [data, total] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        orderBy: orderByFor(filters.sort),
        select: LISTING_SUMMARY_SELECT,
      }),
      this.prisma.replacementListing.count({ where }),
    ]);

    const applicationsCount = await countApplicationsPerListing(
      this.prisma,
      data.map((listing) => listing.id),
    );

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCountFor(listing, applicationsCount)),
      ),
      meta: paginationMeta(total, page, limit),
    };
  }

  /**
   * Counts for the browse screen's summary panels, over the whole matching
   * collection and never over the rows of one page.
   *
   * The feed reports `meta.total` for the active filter, which is enough to say
   * "42 results" and nothing more. These three numbers are what the panels need,
   * and a client that wanted them had no honest way to get them: aggregating the
   * rows it happened to receive produces a figure that changes as the reader
   * pages and is simply wrong past the first hundred.
   *
   * `specialty` is dropped from the predicate on purpose. A panel reading
   * « Médecine générale — 12 » while the reader has just filtered to
   * Dermatologie is answering a question nobody asked; the distribution is meant
   * to show what else is available. Every other filter (city, dates, urgent) is
   * kept, because those genuinely narrow what the reader can still pick from.
   *
   * The urgent count is a second aggregate rather than a derived subtraction,
   * so that adding a specialty filter later cannot quietly change what "urgent"
   * is counting.
   */
  async findFacets(filters: FindReplacementListingsDto) {
    const { specialty: _specialty, status: _status, ...scope } = filters;

    const where: Prisma.ReplacementListingWhereInput = {
      ...this.buildListingsWhere(scope, { publicOnly: true }),
      status: "OPEN",
    };

    const [grouped, urgent] = await Promise.all([
      this.prisma.replacementListing.groupBy({
        by: ["specialty"],
        where,
        _count: true,
      }),
      this.prisma.replacementListing.count({
        where: { ...where, urgent: true },
      }),
    ]);

    // Seeded with the whole enum so a specialty with no listing reads as a zero
    // the panel draws, not as a row that vanished.
    const bySpecialty = Object.fromEntries(
      Object.values(Specialty).map((specialty) => [specialty, 0]),
    ) as Record<Specialty, number>;

    let total = 0;
    for (const row of grouped) {
      bySpecialty[row.specialty] = row._count;
      total += row._count;
    }

    return { total, urgent, bySpecialty };
  }

  /**
   * The places the browse map draws, over the whole matching collection.
   *
   * Not the page, and not a hundred postings: the map shows the collection a
   * filter selects, and feeding it a page meant it redrew whenever the reader
   * paged. Feeding it a capped slice of postings instead was no better — at
   * five openings a practice, a hundred postings cover twenty practices of N,
   * and the rest of the country left the map without a word saying so. Places
   * are the unit the map draws, so places are the unit this reads.
   *
   * Three reads, and no raw SQL: `groupBy` for the population, one `findMany`
   * for the coordinates of every practice involved, one for the previews. The
   * alternative — a window function over the postings — would need the filters
   * written a second time in SQL, and the two definitions would drift.
   *
   * The shape is measured rather than provisional: reading every OPEN listing
   * of the practices drawn costs ~33 ms on the product corpus (620 practices,
   * ~2.2k OPEN) and ~133 ms at roughly seven times that size, while the
   * response stays capped by `maxPlaces`. A `JOIN LATERAL … LIMIT 4` would
   * bound the work per place, but it would duplicate the predicates in SQL; it
   * is the right trade only once practices publish hundreds of listings each.
   * `bun run profile` measures that case against a throwaway database.
   */
  async findPlaces(filters: FindPlacesDto, maxPlaces: number) {
    const where: Prisma.ReplacementListingWhereInput = {
      ...this.buildListingsWhere(filters, { publicOnly: true }),
      status: "OPEN",
    };

    const grouped = await this.prisma.replacementListing.groupBy({
      by: ["practiceId"],
      where,
      _count: true,
    });

    const ranked = grouped
      .map((group) => ({ practiceId: group.practiceId, count: group._count }))
      .sort((a, b) => b.count - a.count);

    // Every practice involved, not only the busiest ones: which of them has no
    // coordinates decides both the map and the "N could not be placed" line,
    // and that is a fact about the whole collection.
    const practices = await this.prisma.practice.findMany({
      where: { id: { in: ranked.map((place) => place.practiceId) } },
      select: PRACTICE_PLACES_SELECT,
    });

    // One pass, two tallies, a lookup table. The shape this replaces looked up
    // the practice with `practices.find` and then re-walked `ranked` a second
    // time to count the ones `mappable` did not hold — both quadratic in the
    // whole collection, and the cap below bounds the response rather than any of
    // the work leading to it.
    const practiceById = new Map(practices.map((p) => [p.id, p]));
    const mappable: typeof ranked = [];
    let unlocated = 0;

    for (const place of ranked) {
      const practice = practiceById.get(place.practiceId);
      if (practice?.latitude != null && practice?.longitude != null) {
        mappable.push(place);
      } else {
        unlocated += place.count;
      }
    }

    const places = mappable.slice(0, maxPlaces);
    const placeIds = places.map((place) => place.practiceId);

    /**
     * The previews, for the places that survived the cap — and only those.
     *
     * This read used to walk the whole matching collection, ordered, because the
     * same query also carried the id of every posting so the browser could find
     * one of them later (`indexOf` over 827 ids, 23 kB of payload). Asking the
     * database for a position instead — see `precedesInOrder` — leaves this read
     * asking only about the practices the map actually draws, and it no longer
     * depends on the reader's ordering at all: a reordering used to redraw the
     * whole map for a popup list the reordering does not change.
     */
    const previews = await this.prisma.replacementListing.findMany({
      where: { ...where, practiceId: { in: placeIds } },
      select: PLACE_LISTING_SELECT,
    });

    return {
      places: assemblePlaces(practices, places, previews),
      unlocated,
      totalPlaces: mappable.length,
      truncated: places.length < mappable.length,
    };
  }

  /**
   * Which page of the reader's ordering holds one posting, or null if the
   * current filters do not show it at all.
   *
   * The map covers the whole filtered collection while the list shows one page
   * of it, so a posting picked from a popup can be anywhere. Turning the list to
   * it needs its position, and this is that question asked once — when the reader
   * asks it — rather than as a by-product of every map read.
   *
   * Two reads: the posting's own sort keys, matched against the filters so that a
   * posting outside the current view answers null rather than a page it is not
   * on; then the count of what outranks it. Both are index-sized, and neither
   * transfers the collection the way the id list did.
   *
   * `null` is not a failure. It means "this is not where the reader is looking",
   * and the caller turns to nothing rather than to a wrong page — the list is
   * still correct, it just cannot show a posting it is not showing.
   */
  async findPageOf(id: string, filters: FindPageOfDto) {
    const scope: Prisma.ReplacementListingWhereInput = {
      ...this.buildListingsWhere(filters, { publicOnly: true }),
      status: "OPEN",
    };

    const target = await this.prisma.replacementListing.findFirst({
      where: { AND: [scope, { id }] },
      select: { id: true, createdAt: true, startDate: true, urgent: true },
    });

    if (!target) {
      return { page: null };
    }

    const ahead = await this.prisma.replacementListing.count({
      where: {
        AND: [scope, precedesInOrder(target, filters.sort)],
      },
    });

    // The page the list pages through: ten rows to a page, so the first row's
    // rank is page 1.
    return { page: Math.floor(ahead / this.browsePageSize(filters)) + 1 };
  }

  /**
   * Rows to a page for this read, from the endpoint's own bound.
   *
   * The same number the browser asks the feed with, and the same number the map's
   * previews are spaced against. Read from the endpoint's pagination bounds
   * rather than hard-coded, so the two can never drift into naming a page
   * boundary that the feed does not have.
   */
  private browsePageSize(filters: FindPageOfDto) {
    return paginate(filters).limit;
  }

  async findMine(userId: string, filters: FindReplacementListingsDto) {
    const profileId = await getOwnedProfileId(this.prisma, userId);

    const { page, limit, skip } = paginate(filters);
    const where = {
      createdById: profileId,
      ...this.buildListingsWhere(filters),
    };

    const // The buckets count every filter the paginator applies except the
      // status one: bucketing by a status the caller already filtered on would
      // zero every other tab.
      { status: _status, ...countFilters } = filters;
    const countsWhere = {
      createdById: profileId,
      ...this.buildListingsWhere(countFilters),
    };

    const [data, total, counts, nextRecruiting] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        // createdAt is not unique, so ordering by it alone leaves Postgres free to
        // return two rows in either order between two pages: offset pagination then
        // repeats one and skips the other. The id breaks the tie.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: LISTING_SUMMARY_SELECT,
      }),
      this.prisma.replacementListing.count({ where }),
      this.countListingsByStatus(countsWhere),
      this.findNextRecruitingListing(profileId),
    ]);

    const applicationsCount = await countApplicationsPerListing(
      this.prisma,
      data.map((listing) => listing.id),
    );

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCountFor(listing, applicationsCount)),
      ),
      meta: {
        ...paginationMeta(total, page, limit),
        counts,
        nextRecruitingListing: nextRecruiting,
      },
    };
  }

  /**
   * The soonest period still to come, among the postings that are in play.
   *
   * Sent beside the page rather than derived by the client from it. A client can
   * only answer this by reading every page of the owner's postings and comparing
   * dates, which is how the dashboard used to answer it — and the answer it got
   * was whichever postings happened to fit in the pages it walked: a practice
   * with more postings than one page holds was shown the soonest period among
   * the most recent hundred, which is a wrong date on a home screen rather than
   * an obviously missing one.
   *
   * Deliberately *not* over `where`: the caller may be reading one status
   * bucket, and « your next replacement » does not change because the dashboard
   * happens to be filtered on something else.
   *
   * `startDate` is not unique either, so the id breaks the tie — without it,
   * two postings starting the same day could come back in either order and the
   * card would name a different one each visit.
   */
  private async findNextRecruitingListing(profileId: string) {
    const listing = await this.prisma.replacementListing.findFirst({
      where: {
        createdById: profileId,
        status: { in: IN_PLAY_LISTING_STATUSES },
        startDate: { gt: new Date() },
      },
      orderBy: [{ startDate: "asc" }, { id: "asc" }],
      select: { id: true, title: true, startDate: true, endDate: true },
    });

    if (!listing) return null;

    return {
      id: listing.id,
      title: listing.title,
      // ISO strings, like the rest of the wire: the client formats the bounds in
      // the reader's locale, and a Date here would arrive as a string anyway.
      startDate: listing.startDate.toISOString(),
      endDate: listing.endDate.toISOString(),
    };
  }

  private async countListingsByStatus(
    where: Prisma.ReplacementListingWhereInput,
  ) {
    const grouped = await this.prisma.replacementListing.groupBy({
      by: ["status"],
      where,
      _count: true,
    });

    const counts = Object.fromEntries(
      Object.values(LISTING_STATUSES).map((status) => [status, 0]),
    ) as Record<ListingStatus, number>;
    let total = 0;

    for (const row of grouped) {
      counts[row.status] = row._count;
      total += row._count;
    }

    return { ...counts, total };
  }

  async findOne(id: string, requesterUserId?: string) {
    const listing = await this.prisma.replacementListing.findUnique({
      where: { id },
      include: LISTING_INCLUDE,
    });

    if (!listing) {
      throw new NotFoundException(`Replacement listing ${id} not found`);
    }

    if (listing.status !== "OPEN") {
      if (!requesterUserId) {
        throw new NotFoundException(`Replacement listing ${id} not found`);
      }

      const profileId = await getOwnedProfileIdSafe(
        this.prisma,
        requesterUserId,
      );

      if (listing.createdById !== profileId) {
        throw new NotFoundException(`Replacement listing ${id} not found`);
      }
    }

    return toReplacementListingDto(this.withCount(listing));
  }

  /**
   * Loads a listing and settles who may act on it.
   *
   * Takes the client rather than reading through `this.prisma`, so a caller
   * already inside a transaction keeps its read and its write in one: a guard that
   * reads on another connection can be overtaken between the read and the write,
   * which is the whole reason `remove` is transactional.
   */
  private async assertOwnershipWith(
    client: PrismaService | Prisma.TransactionClient,
    id: string,
    userId: string,
  ) {
    const listing = await client.replacementListing.findUnique({
      where: { id },
    });

    if (!listing) {
      throw new NotFoundException(`Replacement listing ${id} not found`);
    }

    const profileId = await getOwnedProfileId(client, userId);

    if (listing.createdById !== profileId) {
      throw new ForbiddenException();
    }

    return listing;
  }

  async publish(id: string, userId: string) {
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const listing = await this.assertOwnershipWith(tx, id, userId);

        if (listing.status !== "DRAFT") {
          throw refusal(
            REFUSAL_CODES.listingNotDraft,
            "Only draft listings can be published",
          );
        }

        return tx.replacementListing.update({
          where: { id },
          data: { status: "OPEN" },
        });
      },
    );

    return toReplacementListingDto({ ...updated, applicationsCount: 0 });
  }

  /**
   * Updates a listing's content.
   *
   * A change of `maxApplications` also re-derives the status. That was missing,
   * and the listing is the worse for it: a `FULL` listing whose owner raised the
   * cap stayed `FULL` and refused every candidate it now had room for, with no
   * transition anywhere that could undo it. The capacity is one of the two inputs
   * to `deriveListingStatus`, so writing it without re-deriving leaves the row
   * claiming something the code no longer believes.
   *
   * One transaction, so the count the derivation reads and the write it decides on
   * agree. When the derivation moved the status, the row is read again: the value
   * the route answers with has to be the one that was written.
   */
  async update(id: string, userId: string, dto: UpdateReplacementListingDto) {
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const listing = await this.assertOwnershipWith(tx, id, userId);

        if (isTerminalListingStatus(listing.status)) {
          throw refusal(
            REFUSAL_CODES.listingNotModifiable,
            "This listing can no longer be modified",
          );
        }

        const startDate = dto.startDate
          ? new Date(dto.startDate)
          : listing.startDate;
        const endDate = dto.endDate ? new Date(dto.endDate) : listing.endDate;
        if (startDate >= endDate) {
          throw refusal(
            REFUSAL_CODES.listingInvalidDates,
            "startDate must be before endDate",
          );
        }

        const updated = await tx.replacementListing.update({
          where: { id },
          data: {
            ...dto,
            startDate: dto.startDate ? startDate : undefined,
            endDate: dto.endDate ? endDate : undefined,
          },
          include: APPLICATIONS_COUNT_INCLUDE,
        });

        if (dto.maxApplications === undefined) {
          return updated;
        }

        await recalcListingStatus(tx, id);

        return tx.replacementListing.findUniqueOrThrow({
          where: { id },
          include: APPLICATIONS_COUNT_INCLUDE,
        });
      },
    );

    return toReplacementListingDto(this.withCount(updated));
  }

  /**
   * Deletes a listing, unless a cascade would take somebody else's application.
   *
   * The whole body is one serializable transaction, and that is the point rather
   * than tidiness. Reading the listing, counting the third-party applications and
   * deleting were three statements on three connections: an application committed
   * in the gap was not seen by the count and went with the cascade. The guard is
   * there to protect another candidate's row, and outside a transaction it does
   * not.
   */
  async remove(id: string, userId: string) {
    const deleted = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const listing = await this.assertOwnershipWith(tx, id, userId);

        if (listing.status === "FILLED") {
          throw refusal(
            REFUSAL_CODES.listingFilledCannotBeDeleted,
            "A filled listing cannot be deleted, close it instead",
          );
        }

        await assertNoThirdPartyApplications(
          tx,
          listing.createdById,
          { id: listing.id },
          LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
        );

        // Returned raw and mapped below: the route serializes with the listing
        // DTO, which expects ISO dates and an application count, and a Prisma row
        // satisfies neither.
        return tx.replacementListing.delete({ where: { id } });
      },
    );

    return toReplacementListingDto({ ...deleted, applicationsCount: 0 });
  }

  async close(id: string, userId: string) {
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const listing = await this.assertOwnershipWith(tx, id, userId);

        // Closing is for a posting still in circulation, so a DRAFT or an
        // already-terminal listing is refused.
        //
        // `IN_DISCUSSION` and `FULL` are *not* refused, and that is the fix. They
        // are what a listing with candidates on it becomes, so the previous guard
        // — which accepted only `OPEN` and `FILLED` — made it impossible to close
        // a posting that had shortlisted candidates. `cancel` was the only way
        // out, and cancel tells every one of those candidates the posting was
        // abandoned rather than closed, which is a different sentence about the
        // same event.
        if (
          MANUAL_LISTING_STATUSES.includes(listing.status) ||
          (isTerminalListingStatus(listing.status) &&
            listing.status !== "FILLED")
        ) {
          throw refusal(
            REFUSAL_CODES.listingNotCloseable,
            "Only a listing still in circulation can be closed",
          );
        }

        // A FILLED listing closed out with a placement on it; any other was
        // closed with nobody retained, candidates or not. Both leave circulation,
        // and a candidate who was shortlisted has to be able to tell the two
        // apart — which the reason below also does.
        const closed = await tx.replacementListing.update({
          where: { id },
          data: {
            status:
              listing.status === "FILLED" ? "CLOSED" : "CLOSED_NO_CANDIDATE",
          },
          include: APPLICATIONS_COUNT_INCLUDE,
        });

        // Inside the transaction, like in `cancel`: a candidate who applies
        // between the read and the write used to land on a listing that had just
        // left circulation.
        await rejectActiveApplicationsOnListing(
          tx,
          id,
          PLATFORM_REJECTION_REASONS.listingWithdrawn,
          new Date(),
        );

        return closed;
      },
    );

    return toReplacementListingDto(this.withCount(updated));
  }

  async cancel(id: string, userId: string) {
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        // The same read-and-ownership guard `publish`, `update` and `remove`
        // run through, inside the transaction like them: the write it authorizes
        // and the read that authorizes it stay on one connection.
        const listing = await this.assertOwnershipWith(tx, id, userId);

        // Every terminal status, `FILLED` included. A filled listing carries a
        // placement that was agreed with a candidate; cancelling it would leave
        // that candidate holding a replacement on a posting that no longer
        // exists, which is why it has to be closed instead.
        if (isTerminalListingStatus(listing.status)) {
          throw refusal(
            REFUSAL_CODES.listingAlreadyClosed,
            listing.status === "FILLED"
              ? "A filled listing cannot be cancelled, close it instead"
              : "This listing is already closed or cancelled",
          );
        }

        const now = new Date();

        await rejectActiveApplicationsOnListing(
          tx,
          id,
          PLATFORM_REJECTION_REASONS.listingCancelled,
          now,
        );

        return tx.replacementListing.update({
          where: { id },
          data: { status: "CANCELLED" },
          include: APPLICATIONS_COUNT_INCLUDE,
        });
      },
    );

    return toReplacementListingDto(this.withCount(updated));
  }
}
