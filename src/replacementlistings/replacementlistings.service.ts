import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  REASON_LISTING_CANCELLED,
  REASON_LISTING_CLOSED,
} from "../applications/rejection-reasons";
import {
  assertNoThirdPartyApplications,
  LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
} from "../common/application-guard";
import { getOwnedProfileId } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { Prisma } from "../generated/prisma/client";
import type {
  ApplicationStatus,
  ListingStatus,
} from "../generated/prisma/enums";
import { PrismaService } from "../prisma.service";
import type { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import type { FindReplacementListingsDto } from "./dto/find-replacementlistings.dto";
import type { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
import { toReplacementListingDto } from "./replacementlisting.mapper";

const ACTIVE_LISTING_STATUSES: ListingStatus[] = [
  "DRAFT",
  "OPEN",
  "IN_DISCUSSION",
  "FULL",
  "FILLED",
];
const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
];

const APPLICATIONS_COUNT_INCLUDE = {
  _count: {
    select: {
      applications: { where: { status: { in: ACTIVE_APPLICATION_STATUSES } } },
    },
  },
};

/**
 * Terminates every active application on a listing that stops recruiting.
 *
 * Both `close` and `cancel` must go through this: the deletion guard counts
 * active applications from other candidates, so a listing left with `PENDING`
 * or `SHORTLISTED` rows keeps its owner permanently blocked from deleting
 * their account.
 */
async function terminateActiveApplications(
  tx: Prisma.TransactionClient,
  listingId: string,
  reason: string,
): Promise<void> {
  await tx.application.updateMany({
    where: {
      listingId,
      status: { in: ACTIVE_APPLICATION_STATUSES },
    },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      respondedAt: new Date(),
    },
  });
}

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
            throw new BadRequestException(
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
   * Filters shared by the public search and the owner's collection.
   *
   * Deliberately does NOT include `status`: `findAll` pins `status: "OPEN"`
   * and then spreads this result, so a status key here would silently override
   * that pin and let the public endpoint return drafts or cancelled listings.
   */
  private buildListingsWhere(filters: FindReplacementListingsDto) {
    return {
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
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      status: "OPEN" as const,
      ...this.buildListingsWhere(filters),
    };

    const [data, total] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: APPLICATIONS_COUNT_INCLUDE,
      }),
      this.prisma.replacementListing.count({ where }),
    ]);

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCount(listing)),
      ),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Per-status totals over the owner's whole collection, computed WITHOUT the
   * status filter. The bucket tabs need the counts of every bucket whatever
   * the active one is — otherwise selecting "En cours" would zero the counters
   * of "Terminées" and make them unclickable.
   */
  private async countListingsByStatus(createdById: string) {
    const grouped = await this.prisma.replacementListing.groupBy({
      by: ["status"],
      where: { createdById },
      _count: true,
    });

    const counts = {
      total: 0,
      DRAFT: 0,
      OPEN: 0,
      IN_DISCUSSION: 0,
      FULL: 0,
      FILLED: 0,
      CLOSED: 0,
      CANCELLED: 0,
    } as Record<ListingStatus | "total", number>;

    for (const row of grouped) {
      counts[row.status] = row._count;
      counts.total += row._count;
    }

    return counts;
  }

  async findMine(userId: string, filters: FindReplacementListingsDto) {
    const profileId = await getOwnedProfileId(this.prisma, userId);

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const baseWhere = {
      createdById: profileId,
      ...this.buildListingsWhere(filters),
    };

    const where = {
      ...baseWhere,
      status: filters.status ? { in: filters.status } : undefined,
    };

    const [data, total, counts] = await Promise.all([
      this.prisma.replacementListing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: APPLICATIONS_COUNT_INCLUDE,
      }),
      this.prisma.replacementListing.count({ where }),
      this.countListingsByStatus(profileId),
    ]);

    return {
      data: data.map((listing) =>
        toReplacementListingDto(this.withCount(listing)),
      ),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        counts,
      },
    };
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

      const profileId = await getOwnedProfileId(
        this.prisma,
        requesterUserId,
      ).catch(() => undefined);

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
      throw new BadRequestException("Only draft listings can be published");
    }

    const updated = await this.prisma.replacementListing.update({
      where: { id },
      data: { status: "OPEN" },
    });

    return toReplacementListingDto({ ...updated, applicationsCount: 0 });
  }

  async update(id: string, userId: string, dto: UpdateReplacementListingDto) {
    const listing = await this.assertOwnership(id, userId);

    if (
      listing.status === "FILLED" ||
      listing.status === "CLOSED" ||
      listing.status === "CANCELLED"
    ) {
      throw new BadRequestException("This listing can no longer be modified");
    }

    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : listing.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : listing.endDate;
    if (startDate >= endDate) {
      throw new BadRequestException("startDate must be before endDate");
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
      throw new BadRequestException(
        "A filled listing cannot be deleted, close it instead",
      );
    }

    const profileId = await getOwnedProfileId(this.prisma, userId);

    await assertNoThirdPartyApplications(
      this.prisma,
      profileId,
      { id },
      LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
    );

    const deleted = await this.prisma.replacementListing.delete({
      where: { id },
    });

    // Mapped like every other listing this service returns. The delete handler
    // is annotated with the listing DTO, whose dates are strings and which
    // requires `applicationsCount`; returning the raw row serialised a `Date`
    // where a string was declared and omitted the count, so the
    // `ZodSerializerInterceptor` threw a `ZodSerializationException` — a 500 —
    // on a request that had already done its job. The row was gone and the
    // caller was told it had failed. An e2e test over HTTP is what surfaced
    // it; no unit test could, because the fake was never serialised.
    return toReplacementListingDto({ ...deleted, applicationsCount: 0 });
  }

  async close(id: string, userId: string) {
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

        if (listing.status !== "OPEN" && listing.status !== "FILLED") {
          throw new BadRequestException(
            "Only open or filled listings can be closed",
          );
        }

        await terminateActiveApplications(tx, id, REASON_LISTING_CLOSED);

        return tx.replacementListing.update({
          where: { id },
          data: { status: "CLOSED" },
          include: APPLICATIONS_COUNT_INCLUDE,
        });
      },
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

        if (listing.status === "CLOSED" || listing.status === "CANCELLED") {
          throw new BadRequestException(
            "This listing is already closed or cancelled",
          );
        }

        await terminateActiveApplications(tx, id, REASON_LISTING_CANCELLED);

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
