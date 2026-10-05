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
  isTerminalListingStatus,
  RECRUITING_LISTING_STATUSES,
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
import { ListingStatus as LISTING_STATUSES } from "../generated/prisma/enums";
import { PrismaService } from "../prisma.service";
import type { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import type { FindReplacementListingsDto } from "./dto/find-replacementlistings.dto";
import type { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
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

@Injectable()
export class ReplacementlistingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private withCount<T extends { _count: { applications: number } }>(
    listing: T,
  ) {
    const { _count, ...rest } = listing;
    return { ...rest, applicationsCount: _count.applications };
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

  private buildListingsWhere(filters: FindReplacementListingsDto) {
    return {
      status: filters.status,
      specialty: filters.specialty,
      urgent: filters.urgent,
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
      practice: filters.city
        ? { city: { contains: filters.city, mode: "insensitive" as const } }
        : undefined,
    };
  }

  async findAll(filters: FindReplacementListingsDto) {
    const { page, limit, skip } = paginate(filters);
    // The public feed is OPEN whatever the caller asked for: a status filter on
    // a listing somebody else owns would turn the feed into a way to read the
    // statuses of postings still in circulation.
    const { status: _statusFilter, ...publicFilters } = filters;
    const where: Prisma.ReplacementListingWhereInput = {
      ...this.buildListingsWhere(publicFilters),
      status: "OPEN",
    };

    const [data, total] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        // createdAt is not unique, so ordering by it alone leaves Postgres free to
        // return two rows in either order between two pages: offset pagination then
        // repeats one and skips the other. The id breaks the tie.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: APPLICATIONS_COUNT_INCLUDE,
      }),
      this.prisma.replacementListing.count({ where }),
    ]);

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCount(listing)),
      ),
      meta: paginationMeta(total, page, limit),
    };
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

    const [data, total, counts] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        // createdAt is not unique, so ordering by it alone leaves Postgres free to
        // return two rows in either order between two pages: offset pagination then
        // repeats one and skips the other. The id breaks the tie.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: APPLICATIONS_COUNT_INCLUDE,
      }),
      this.prisma.replacementListing.count({ where }),
      this.countListingsByStatus(countsWhere),
    ]);

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCount(listing)),
      ),
      meta: {
        ...paginationMeta(total, page, limit),
        counts,
      },
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
      include: APPLICATIONS_COUNT_INCLUDE,
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

  private async assertOwnership(id: string, userId: string) {
    const listing = await this.prisma.replacementListing.findUnique({
      where: { id },
    });

    if (!listing) {
      throw new NotFoundException(`Replacement listing ${id} not found`);
    }

    const profileId = await getOwnedProfileId(this.prisma, userId);

    if (listing.createdById !== profileId) {
      throw new ForbiddenException();
    }

    return listing;
  }

  async publish(id: string, userId: string) {
    const listing = await this.assertOwnership(id, userId);

    if (listing.status !== "DRAFT") {
      throw refusal(
        REFUSAL_CODES.listingNotDraft,
        "Only draft listings can be published",
      );
    }

    const updated = await this.prisma.replacementListing.update({
      where: { id },
      data: { status: "OPEN" },
    });

    return toReplacementListingDto({ ...updated, applicationsCount: 0 });
  }

  async update(id: string, userId: string, dto: UpdateReplacementListingDto) {
    const listing = await this.assertOwnership(id, userId);

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

    const updated = await this.prisma.replacementListing.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? startDate : undefined,
        endDate: dto.endDate ? endDate : undefined,
      },
      include: APPLICATIONS_COUNT_INCLUDE,
    });

    return toReplacementListingDto(this.withCount(updated));
  }

  async remove(id: string, userId: string) {
    const listing = await this.assertOwnership(id, userId);

    if (listing.status === "FILLED") {
      throw refusal(
        REFUSAL_CODES.listingFilledCannotBeDeleted,
        "A filled listing cannot be deleted, close it instead",
      );
    }

    await assertNoThirdPartyApplications(
      this.prisma,
      listing.createdById,
      { id: listing.id },
      LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
    );

    // Mapped like every other read: the route serializes with the listing DTO,
    // which expects ISO dates and an application count, and a raw Prisma row
    // satisfies neither.
    const deleted = await this.prisma.replacementListing.delete({
      where: { id },
    });

    return toReplacementListingDto({ ...deleted, applicationsCount: 0 });
  }

  async close(id: string, userId: string) {
    const listing = await this.assertOwnership(id, userId);

    if (listing.status !== "OPEN" && listing.status !== "FILLED") {
      throw refusal(
        REFUSAL_CODES.listingNotCloseable,
        "Only open or filled listings can be closed",
      );
    }

    // A FILLED listing closed out with a placement on it, an OPEN one was closed
    // with nobody retained. Both leave circulation, and a candidate who was
    // shortlisted has to be able to tell the two apart.
    const updated = await this.prisma.replacementListing.update({
      where: { id },
      data: {
        status: listing.status === "FILLED" ? "CLOSED" : "CLOSED_NO_CANDIDATE",
      },
      include: APPLICATIONS_COUNT_INCLUDE,
    });

    await rejectActiveApplicationsOnListing(
      this.prisma,
      id,
      PLATFORM_REJECTION_REASONS.listingWithdrawn,
      new Date(),
    );

    return toReplacementListingDto(this.withCount(updated));
  }

  async cancel(id: string, userId: string) {
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const listing = await tx.replacementListing.findUnique({
          where: { id },
        });
        if (!listing) {
          throw new NotFoundException(`Replacement listing ${id} not found`);
        }

        const profileId = await getOwnedProfileId(tx, userId);

        if (listing.createdById !== profileId) {
          throw new ForbiddenException();
        }

        if (
          listing.status === "CLOSED" ||
          listing.status === "CLOSED_NO_CANDIDATE" ||
          listing.status === "CANCELLED"
        ) {
          throw refusal(
            REFUSAL_CODES.listingAlreadyClosed,
            "This listing is already closed or cancelled",
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
