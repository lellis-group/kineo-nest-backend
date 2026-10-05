import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ACTIVE_APPLICATION_STATUSES } from "../common/listing-status";
import { getOwnedProfile, getOwnedProfileId } from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { Prisma } from "../generated/prisma/client";
import type { ApplicationStatus } from "../generated/prisma/enums";
import { PrismaService } from "../prisma.service";
import { toApplicationDto } from "./application.mapper";
import { CreateApplicationDto } from "./dto/create-application.dto";
import type { FindApplicationsDto } from "./dto/find-applications.dto";
import { RejectApplicationDto } from "./dto/reject-application.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { WithdrawApplicationDto } from "./dto/withdraw-application.dto";

// The mapper publishes name and image and nothing else, so a paginated list
// does not need the email, the verification flag and the timestamps that
// `include: { user: true }` pulled in on every row.
const USER_CARD_SELECT = { name: true, image: true } as const;

@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async recalcListingStatus(
    tx: Prisma.TransactionClient,
    listingId: string,
  ) {
    const listing = await tx.replacementListing.findUnique({
      where: { id: listingId },
    });

    if (
      !listing ||
      listing.status === "FILLED" ||
      listing.status === "CLOSED" ||
      listing.status === "CANCELLED"
    ) {
      return;
    }

    const activeCount = await tx.application.count({
      where: { listingId, status: { in: ACTIVE_APPLICATION_STATUSES } },
    });

    let nextStatus = listing.status;

    if (activeCount === 0) {
      nextStatus = "OPEN";
    } else if (
      listing.maxApplications &&
      activeCount >= listing.maxApplications
    ) {
      nextStatus = "FULL";
    } else {
      nextStatus = "IN_DISCUSSION";
    }

    if (nextStatus !== listing.status) {
      await tx.replacementListing.update({
        where: { id: listingId },
        data: { status: nextStatus },
      });
    }
  }

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

    const where = { listingId, status: filters.status };

    const [data, total, counts] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          applicant: { include: { user: { select: USER_CARD_SELECT } } },
        },
      }),
      this.prisma.application.count({ where }),
      this.countApplicationsByStatus({ listingId }),
    ]);

    return {
      data: data.map(toApplicationDto),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        counts,
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
      status: filters.status,
      listingId: filters.listingId,
    };

    const [data, total, counts] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { listing: { include: { practice: true } } },
      }),
      this.prisma.application.count({ where }),
      this.countApplicationsByStatus({
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
      },
    };
  }

  private async assertAccess(id: string, userId: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        listing: { include: { practice: true } },
        applicant: { include: { user: true } },
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

    if (application.status !== "PENDING") {
      throw new BadRequestException("Only pending applications can be edited");
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data: { message: dto.message },
    });

    return toApplicationDto(updated);
  }

  async shortlist(id: string, userId: string) {
    const { application, isOwner } = await this.assertAccess(id, userId);

    if (!isOwner) {
      throw new ForbiddenException();
    }

    if (application.status !== "PENDING") {
      throw new BadRequestException(
        "Only pending applications can be shortlisted",
      );
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data: { status: "SHORTLISTED", respondedAt: new Date() },
    });

    return toApplicationDto(updated);
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
        if (
          listing.status === "FILLED" ||
          listing.status === "CLOSED" ||
          listing.status === "CANCELLED"
        ) {
          throw new BadRequestException(
            "This listing can no longer accept an application",
          );
        }

        const now = new Date();
        const updated = await tx.application.update({
          where: { id },
          data: { status: "ACCEPTED", respondedAt: now },
        });
        await tx.application.updateMany({
          where: {
            listingId: application.listingId,
            id: { not: id },
            status: { in: ACTIVE_APPLICATION_STATUSES },
          },
          data: {
            status: "REJECTED",
            rejectionReason: "Another candidate was selected for this listing",
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
            rejectionReason: dto.rejectionReason,
            respondedAt: new Date(),
          },
        });

        await this.recalcListingStatus(tx, application.listingId);

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
            withdrawnReason: dto.withdrawnReason,
          },
        });

        await this.recalcListingStatus(tx, application.listingId);

        return updated;
      },
    );

    return toApplicationDto(withdrawn);
  }
}
