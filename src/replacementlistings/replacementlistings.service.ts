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
  REASON_LISTING_CLOSED_NO_CANDIDATE,
} from "../applications/rejection-reasons";
import {
  assertNoThirdPartyApplications,
  LISTING_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
} from "../common/application-guard";
import {
  recalcListingStatus,
  TERMINAL_LISTING_STATUSES,
} from "../common/listing-status";
import { getOwnedProfileId } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { Prisma } from "../generated/prisma/client";
import type {
  ApplicationDecisionSource,
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
  decisionSource: ApplicationDecisionSource,
): Promise<void> {
  await tx.application.updateMany({
    where: {
      listingId,
      status: { in: ACTIVE_APPLICATION_STATUSES },
    },
    data: {
      status: "REJECTED",
      // Which owner action ended the posting, so the applicant reads "the
      // practice closed it without anyone" rather than "you were refused".
      decisionSource,
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
        // `id` breaks the ties `createdAt` leaves. Without a total order the
        // database may return a different slice on each call, so page 2 could
        // repeat rows from page 1 and silently drop others.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      CLOSED_NO_CANDIDATE: 0,
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
        // `id` breaks the ties `createdAt` leaves — see `findAll`.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    return this.assertOwnershipWith(this.prisma, id, userId);
  }

  /**
   * Same ownership check against an explicit client, so callers that already
   * opened a serializable transaction can keep the read and the write in it.
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
    const updated = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        // Re-read inside the transaction. `assertOwnership` on its own would
        // leave the status guard and the write as two statements on two
        // connections, so a concurrent `/accept` could move the listing to
        // FILLED between the check and the update, and this would then edit a
        // placement that has already been confirmed.
        //
        // The statuses themselves come from `TERMINAL_LISTING_STATUSES`, the
        // same list `close` and `cancel` refuse from. This guard used to spell
        // out `FILLED || CLOSED || CANCELLED` and so let `CLOSED_NO_CANDIDATE`
        // through: the owner could edit the title and the dates of a posting
        // they had already closed. Every decision to stop modifying a listing
        // reads the shared list, which is what keeps them from drifting apart.
        const listing = await this.assertOwnershipWith(tx, id, userId);

        if (TERMINAL_LISTING_STATUSES.includes(listing.status)) {
          throw new BadRequestException(
            "This listing can no longer be modified",
          );
        }

        const startDate = dto.startDate
          ? new Date(dto.startDate)
          : listing.startDate;
        const endDate = dto.endDate ? new Date(dto.endDate) : listing.endDate;
        if (startDate >= endDate) {
          throw new BadRequestException("startDate must be before endDate");
        }

        const result = await tx.replacementListing.update({
          where: { id },
          data: {
            ...dto,
            startDate: dto.startDate ? startDate : undefined,
            endDate: dto.endDate ? endDate : undefined,
          },
          include: APPLICATIONS_COUNT_INCLUDE,
        });

        // `status` is derived state: it exists so `create` can refuse a
        // candidate on a full listing. Changing `maxApplications` moves one of
        // the two inputs to that derivation, so it has to go back through it.
        // Without this, a FULL listing whose owner raises the cap stays FULL
        // forever and refuses every candidate with free slots, and the module
        // has no transition that can undo it.
        const capacityChanged = dto.maxApplications !== undefined;
        if (capacityChanged) {
          await recalcListingStatus(tx, id);
          // The recalc may have moved the status, so the row has to be read
          // again to return it.
          return tx.replacementListing.findUniqueOrThrow({
            where: { id },
            include: APPLICATIONS_COUNT_INCLUDE,
          });
        }

        return result;
      },
    );

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

        /**
         * Two outcomes, because the applicant reads the difference.
         *
         * `close` used to be reachable only from `OPEN` and `FILLED`, which is
         * why a single reason was enough: `OPEN` held no application at all, and
         * `FILLED` had already retained one. It is now also reachable from
         * `IN_DISCUSSION` and `FULL`, where the posting ends with nobody
         * retained — and that is not what a shortlisted candidate would infer
         * from "clôturée". Hence `CLOSED_NO_CANDIDATE` and its own reason.
         *
         * The refusals are `DRAFT` plus the statuses that never had a candidate
         * to be `close`d for. `FILLED` is terminal yet still reachable: the
         * placement is already written, and closing is how the owner takes the
         * posting out of circulation. `terminateActiveApplications` only settles
         * `PENDING` and `SHORTLISTED`, so the accepted application survives it.
         * `cancel` has no such case and refuses `FILLED`.
         */
        if (
          listing.status === "DRAFT" ||
          (TERMINAL_LISTING_STATUSES.includes(listing.status) &&
            listing.status !== "FILLED")
        ) {
          throw new BadRequestException(
            "Only a listing still in circulation can be closed",
          );
        }

        const closedWithoutCandidate =
          listing.status === "IN_DISCUSSION" || listing.status === "FULL";

        await terminateActiveApplications(
          tx,
          id,
          closedWithoutCandidate
            ? REASON_LISTING_CLOSED_NO_CANDIDATE
            : REASON_LISTING_CLOSED,
          closedWithoutCandidate
            ? "LISTING_CLOSED_NO_CANDIDATE"
            : "LISTING_CLOSED",
        );

        return tx.replacementListing.update({
          where: { id },
          data: {
            status: closedWithoutCandidate ? "CLOSED_NO_CANDIDATE" : "CLOSED",
          },
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

        /**
         * `FILLED` is refused alongside the statuses already out of
         * circulation, because a filled listing carries an `ACCEPTED`
         * application: someone has been told they have the post. Cancelling it
         * would leave that candidate holding a confirmed placement on a listing
         * that no longer exists, and `terminateActiveApplications` only settles
         * `PENDING` and `SHORTLISTED`, so the accepted row would survive
         * untouched. No other path produces that combination.
         *
         * `close` is the way out, and `remove` already says so.
         */
        if (TERMINAL_LISTING_STATUSES.includes(listing.status)) {
          throw new BadRequestException(
            listing.status === "FILLED"
              ? "A filled listing cannot be cancelled, close it instead"
              : "This listing is already closed or cancelled",
          );
        }

        await terminateActiveApplications(
          tx,
          id,
          REASON_LISTING_CANCELLED,
          "LISTING_CANCELLED",
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
