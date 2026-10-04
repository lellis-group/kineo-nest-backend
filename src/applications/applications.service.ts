import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ACTIVE_APPLICATION_STATUSES,
  recalcListingStatus,
  TERMINAL_LISTING_STATUSES,
} from "../common/listing-status";
import { getOwnedProfile, getOwnedProfileId } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import {
  ApplicationDecisionSource,
  ApplicationStatus,
  Prisma,
} from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { toApplicationDto } from "./application.mapper";
import { CreateApplicationDto } from "./dto/create-application.dto";
import type { FindApplicationsDto } from "./dto/find-applications.dto";
import { RejectApplicationDto } from "./dto/reject-application.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { WithdrawApplicationDto } from "./dto/withdraw-application.dto";
import { REASON_ANOTHER_CANDIDATE_SELECTED } from "./rejection-reasons";

/**
 * Turns a comma-separated query value into a Prisma filter.
 *
 * The DTO always yields an array, even for one value, so a plain value would be
 * needed back for the single case: `in: [x]` and `x` are the same query, but
 * passing `in: undefined` would be a filter Prisma rejects rather than an absent
 * one.
 */
function oneOrMany<T extends ApplicationStatus | ApplicationDecisionSource>(
  values: T[] | undefined,
): T | { in: T[] } | undefined {
  if (!values) {
    return undefined;
  }
  return values.length === 1 ? values[0] : { in: values };
}

@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Totals per status over the whole collection, so tab counters stay stable
   * across pages and filters.
   */
  private async countApplicationsByStatus(
    where: Prisma.ApplicationWhereInput,
  ): Promise<{ total: number } & Record<ApplicationStatus, number>> {
    const grouped = await this.prisma.application.groupBy({
      by: ["status"],
      where,
      _count: true,
    });

    const counts = {
      total: 0,
      PENDING: 0,
      SHORTLISTED: 0,
      ACCEPTED: 0,
      REJECTED: 0,
      WITHDRAWN: 0,
    } as { total: number } & Record<ApplicationStatus, number>;

    for (const row of grouped) {
      counts[row.status] = row._count;
      counts.total += row._count;
    }

    return counts;
  }

  /**
   * Totals per decision source, for the same reason as the status counts.
   *
   * The applicant's screen splits what used to be one « Rejetées » bucket into
   * the situations that read differently to them, and a bucket spanning several
   * sources cannot be counted from the status totals alone. Returned as a full
   * zeroed map so a source that never appears still has a key to sum from.
   *
   * `null` is counted separately: those are the applications still open, where
   * nobody has decided anything.
   */
  private async countApplicationsByDecisionSource(
    where: Prisma.ApplicationWhereInput,
  ): Promise<{ total: number } & Record<ApplicationDecisionSource, number>> {
    const grouped = await this.prisma.application.groupBy({
      by: ["decisionSource"],
      where,
      _count: true,
    });

    const counts = {
      total: 0,
      CANDIDATE_WITHDREW: 0,
      PRACTICE_ACCEPTED: 0,
      PRACTICE_REJECTED: 0,
      ANOTHER_CANDIDATE_SELECTED: 0,
      LISTING_CLOSED: 0,
      LISTING_CLOSED_NO_CANDIDATE: 0,
      LISTING_CANCELLED: 0,
      LISTING_ERASED: 0,
      CANDIDATE_UNAVAILABLE: 0,
      undecided: 0,
    } as { total: number } & Record<ApplicationDecisionSource, number> & {
        undecided: number;
      };

    for (const row of grouped) {
      if (row.decisionSource === null) {
        counts.undecided += row._count;
      } else {
        counts[row.decisionSource] = row._count;
      }
      counts.total += row._count;
    }

    return counts;
  }

  async create(userId: string, dto: CreateApplicationDto) {
    const profile = await getOwnedProfile(this.prisma, userId);

    if (profile.profileType === "INSTALLED") {
      throw new ForbiddenException(
        "Only replacement profiles can apply to listings",
      );
    }

    try {
      const application = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          const maxApplications = this.config.get<number>(
            "limits.activeApplicationsPerProfile",
          );
          if (maxApplications) {
            const activeCount = await tx.application.count({
              where: {
                applicantId: profile.id,
                status: { in: ACTIVE_APPLICATION_STATUSES },
              },
            });

            if (activeCount >= maxApplications) {
              throw new BadRequestException(
                `You cannot have more than ${maxApplications} active applications`,
              );
            }
          }

          const listing = await tx.replacementListing.findUnique({
            where: { id: dto.listingId },
          });
          if (!listing) {
            throw new NotFoundException(`Listing ${dto.listingId} not found`);
          }
          if (listing.createdById === profile.id) {
            throw new ForbiddenException(
              "You cannot apply to your own listing",
            );
          }
          if (listing.status !== "OPEN" && listing.status !== "IN_DISCUSSION") {
            throw new BadRequestException(
              "This listing is not accepting applications",
            );
          }

          const activeListingCount = await tx.application.count({
            where: {
              listingId: listing.id,
              status: { in: ACTIVE_APPLICATION_STATUSES },
            },
          });
          if (
            listing.maxApplications &&
            activeListingCount >= listing.maxApplications
          ) {
            throw new BadRequestException(
              "This listing has reached its application limit",
            );
          }

          const created = await tx.application.create({
            data: {
              listingId: listing.id,
              applicantId: profile.id,
              message: dto.message,
            },
          });

          await tx.replacementListing.update({
            where: { id: listing.id },
            data: {
              status:
                listing.maxApplications &&
                activeListingCount + 1 >= listing.maxApplications
                  ? "FULL"
                  : "IN_DISCUSSION",
            },
          });

          return created;
        },
      );

      return toApplicationDto(application);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("You already applied to this listing");
      }
      throw error;
    }
  }

  async findForListing(
    listingId: string,
    userId: string,
    filters: FindApplicationsDto,
  ) {
    const profile = await getOwnedProfile(this.prisma, userId);

    const listing = await this.prisma.replacementListing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      throw new NotFoundException(`Listing ${listingId} not found`);
    }

    if (listing.createdById !== profile.id) {
      throw new ForbiddenException("You do not own this listing");
    }

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      listingId,
      status: oneOrMany(filters.status),
      decisionSource: oneOrMany(filters.decisionSource),
    };

    const [data, total, counts, decisionCounts] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip,
        take: limit,
        // `id` breaks the ties `createdAt` leaves. Two candidates applying in
        // the same transaction share a `createdAt`, and without a total order
        // the database may swap them between two pages.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          applicant: {
            include: {
              user: { select: { name: true, image: true, deletedAt: true } },
            },
          },
        },
      }),
      this.prisma.application.count({ where }),
      this.countApplicationsByStatus({ listingId }),
      this.countApplicationsByDecisionSource({ listingId }),
    ]);

    return {
      data: data.map(toApplicationDto),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        counts,
        decisionCounts,
      },
    };
  }

  async findMine(userId: string, filters: FindApplicationsDto) {
    const profile = await getOwnedProfile(this.prisma, userId);

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      applicantId: profile.id,
      status: oneOrMany(filters.status),
      decisionSource: oneOrMany(filters.decisionSource),
      listingId: filters.listingId,
    };

    const [data, total, counts, decisionCounts] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip,
        take: limit,
        // `id` breaks the ties `createdAt` leaves — see `findForListing`.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { listing: { include: { practice: true } } },
      }),
      this.prisma.application.count({ where }),
      this.countApplicationsByStatus({
        applicantId: profile.id,
        listingId: filters.listingId,
      }),
      this.countApplicationsByDecisionSource({
        applicantId: profile.id,
        listingId: filters.listingId,
      }),
    ]);

    return {
      data: data.map(toApplicationDto),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        counts,
        decisionCounts,
      },
    };
  }

  private async assertAccess(id: string, userId: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        listing: { include: { practice: true } },
        applicant: {
          include: {
            user: { select: { name: true, image: true, deletedAt: true } },
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException(`Application ${id} not found`);
    }

    const profile = await getOwnedProfile(this.prisma, userId);

    const isApplicant = application.applicantId === profile.id;
    const isOwner = application.listing.createdById === profile.id;

    if (!isApplicant && !isOwner) {
      throw new NotFoundException(`Application ${id} not found`);
    }

    return {
      application,
      profile,
      listing: application.listing,
      isApplicant,
      isOwner,
    };
  }

  async findOne(id: string, userId: string) {
    const { application } = await this.assertAccess(id, userId);

    return toApplicationDto(application);
  }

  async markAsViewed(id: string, userId: string) {
    const { application, isOwner } = await this.assertAccess(id, userId);

    if (!isOwner) {
      throw new ForbiddenException();
    }

    if (application.viewedAt) {
      return toApplicationDto(application);
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data: { viewedAt: new Date() },
    });

    return toApplicationDto(updated);
  }

  async update(id: string, userId: string, dto: UpdateApplicationDto) {
    const { application, isApplicant } = await this.assertAccess(id, userId);

    if (!isApplicant) {
      throw new ForbiddenException();
    }

    // Conditional on the status, so the check and the write cannot be split by
    // a concurrent decision. `reject` is serializable, so it and this update
    // used to interleave: the edit landed on a row a rejection had just settled.
    const updated = await this.claimPending(
      application.id,
      { message: dto.message },
      "Only pending applications can be edited",
    );

    return toApplicationDto(updated);
  }

  async shortlist(id: string, userId: string) {
    const { application, isOwner } = await this.assertAccess(id, userId);

    if (!isOwner) {
      throw new ForbiddenException();
    }

    // Conditional for the same reason as `update`, and the reason it matters
    // more here: without it, a `reject` that committed between this read and
    // the write left the row SHORTLISTED while still carrying the practice's
    // rejectionReason and decisionSource — a combination no transition produces,
    // and one that shows the applicant as shortlisted instead of refused.
    const updated = await this.claimPending(
      application.id,
      { status: "SHORTLISTED", respondedAt: new Date() },
      "Only pending applications can be shortlisted",
    );

    return toApplicationDto(updated);
  }

  /**
   * Updates an application only while it is still PENDING, in one statement.
   *
   * A read-then-write pair cannot hold that invariant against a concurrent
   * `reject` or `withdraw`, which are serializable. `updateMany` makes the
   * condition part of the write, so the loser of the race updates nothing and is
   * refused with the same message the read would have given.
   */
  private async claimPending(
    id: string,
    data: Prisma.ApplicationUpdateManyMutationInput,
    refusal: string,
  ) {
    const result = await this.prisma.application.updateMany({
      where: { id, status: "PENDING" },
      data,
    });

    if (result.count === 0) {
      throw new BadRequestException(refusal);
    }

    return this.prisma.application.findUniqueOrThrow({ where: { id } });
  }

  async accept(id: string, userId: string) {
    const accepted = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const profileId = await getOwnedProfileId(tx, userId);

        const application = await tx.application.findUnique({ where: { id } });
        if (!application) {
          throw new NotFoundException(`Application ${id} not found`);
        }

        const listing = await tx.replacementListing.findUnique({
          where: { id: application.listingId },
        });
        if (!listing || listing.createdById !== profileId) {
          throw new NotFoundException(`Application ${id} not found`);
        }
        if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
          throw new BadRequestException(
            "Only pending or shortlisted applications can be accepted",
          );
        }
        // Read from `TERMINAL_LISTING_STATUSES` rather than listing the
        // statuses out here. This guard used to name `FILLED`, `CLOSED` and
        // `CANCELLED` and so let an `accept` through on a listing that `close`
        // had already taken out of circulation — the status was
        // `CLOSED_NO_CANDIDATE`, a terminal status this list did not mention.
        // It only failed to reopen a listing because the applications on a
        // closed one have always been settled, so the `ACTIVE_APPLICATION_STATUSES` check
        // above refused them first. That is a coincidence between two guards,
        // not a property of either: the day `close` stops settling them, the
        // listing reopens through this path.
        if (TERMINAL_LISTING_STATUSES.includes(listing.status)) {
          throw new BadRequestException(
            "This listing can no longer accept an application",
          );
        }

        const now = new Date();
        const updated = await tx.application.update({
          where: { id },
          data: {
            status: "ACCEPTED",
            decisionSource: "PRACTICE_ACCEPTED",
            respondedAt: now,
          },
        });
        await tx.application.updateMany({
          where: {
            listingId: application.listingId,
            id: { not: id },
            status: { in: ACTIVE_APPLICATION_STATUSES },
          },
          data: {
            status: "REJECTED",
            decisionSource: "ANOTHER_CANDIDATE_SELECTED",
            rejectionReason: REASON_ANOTHER_CANDIDATE_SELECTED,
            respondedAt: now,
          },
        });
        await tx.replacementListing.update({
          where: { id: listing.id },
          data: { status: "FILLED" },
        });

        return updated;
      },
    );

    return toApplicationDto(accepted);
  }

  async reject(id: string, userId: string, dto: RejectApplicationDto) {
    const rejected = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const application = await tx.application.findUnique({ where: { id } });
        if (!application) {
          throw new NotFoundException(`Application ${id} not found`);
        }

        const profileId = await getOwnedProfileId(tx, userId);

        const listing = await tx.replacementListing.findUnique({
          where: { id: application.listingId },
        });

        const isOwner = listing?.createdById === profileId;
        const isApplicant = application.applicantId === profileId;

        if (!isOwner && !isApplicant) {
          throw new NotFoundException(`Application ${id} not found`);
        }
        if (!isOwner) {
          throw new ForbiddenException();
        }

        if (
          application.status !== "PENDING" &&
          application.status !== "SHORTLISTED"
        ) {
          throw new BadRequestException(
            "Only pending or shortlisted applications can be rejected",
          );
        }

        const updated = await tx.application.update({
          where: { id },
          data: {
            status: "REJECTED",
            decisionSource: "PRACTICE_REJECTED",
            rejectionReason: dto.rejectionReason,
            respondedAt: new Date(),
          },
        });

        await recalcListingStatus(tx, application.listingId);

        return updated;
      },
    );

    return toApplicationDto(rejected);
  }

  async withdraw(id: string, userId: string, dto: WithdrawApplicationDto) {
    const withdrawn = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const application = await tx.application.findUnique({ where: { id } });
        if (!application) {
          throw new NotFoundException(`Application ${id} not found`);
        }

        const profileId = await getOwnedProfileId(tx, userId);

        const listing = await tx.replacementListing.findUnique({
          where: { id: application.listingId },
        });

        const isApplicant = application.applicantId === profileId;
        const isOwner = listing?.createdById === profileId;

        if (!isApplicant && !isOwner) {
          throw new NotFoundException(`Application ${id} not found`);
        }
        if (!isApplicant) {
          throw new ForbiddenException();
        }

        if (
          application.status !== "PENDING" &&
          application.status !== "SHORTLISTED"
        ) {
          throw new BadRequestException(
            "Only pending or shortlisted applications can be withdrawn",
          );
        }

        const updated = await tx.application.update({
          where: { id },
          data: {
            status: "WITHDRAWN",
            // The one status that can only mean the candidate acted: the
            // account-erasure path writes WITHDRAWN too, but on rows that
            // disappear with the account, so nobody reads this one.
            decisionSource: "CANDIDATE_WITHDREW",
            withdrawnReason: dto.withdrawnReason,
          },
        });

        await recalcListingStatus(tx, application.listingId);

        return updated;
      },
    );

    return toApplicationDto(withdrawn);
  }
}
