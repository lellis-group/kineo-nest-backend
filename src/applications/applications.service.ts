import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ACTIVE_APPLICATION_STATUSES,
  APPLICABLE_LISTING_STATUSES,
  deriveListingStatus,
  isTerminalListingStatus,
} from "../common/listing-status";
import { paginate, paginationMeta } from "../common/pagination";
import { getOwnedProfile, getOwnedProfileId } from "../common/profile-lookup";
import { REFUSAL_CODES, refusal } from "../common/refusal";
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
import { PLATFORM_REJECTION_REASONS } from "./rejection-reasons";

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

  /**
   * Realigns a listing's status with the applications it actually holds.
   *
   * The rule lives in deriveListingStatus, which is also what the quota check
   * in create() reads. This method used to redraw it inline, and the two copies
   * agreed by coincidence.
   */
  private async recalcListingStatus(
    tx: Prisma.TransactionClient,
    listingId: string,
  ) {
    const listing = await tx.replacementListing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      return;
    }

    const activeApplications = await tx.application.count({
      where: { listingId, status: { in: ACTIVE_APPLICATION_STATUSES } },
    });

    const status = deriveListingStatus({
      current: listing.status,
      activeApplications,
      maxApplications: listing.maxApplications,
    });

    if (status !== listing.status) {
      await tx.replacementListing.update({
        where: { id: listingId },
        data: { status },
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
              throw refusal(
                REFUSAL_CODES.applicationQuotaReached,
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
          if (!APPLICABLE_LISTING_STATUSES.includes(listing.status)) {
            throw refusal(
              REFUSAL_CODES.applicationListingNotAccepting,
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
            throw refusal(
              REFUSAL_CODES.applicationListingLimitReached,
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
              // The same derivation the settle paths use, with the
              // application being created included in the count.
              status: deriveListingStatus({
                current: listing.status,
                activeApplications: activeListingCount + 1,
                maxApplications: listing.maxApplications,
              }),
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
        throw new ConflictException({
          statusCode: 409,
          code: REFUSAL_CODES.applicationAlreadyExists,
          message: "You already applied to this listing",
        });
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

    const { page, limit, skip } = paginate(filters);
    const where = { listingId, status: filters.status };

    const [data, total, counts] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip,
        take: limit,
        // createdAt is not unique, so ordering by it alone leaves Postgres free to
        // return two rows in either order between two pages: offset pagination then
        // repeats one and skips the other. The id breaks the tie.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        ...paginationMeta(total, page, limit),
        counts,
      },
    };
  }

  async findMine(userId: string, filters: FindApplicationsDto) {
    const profile = await getOwnedProfile(this.prisma, userId);

    const { page, limit, skip } = paginate(filters);
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
        // createdAt is not unique, so ordering by it alone leaves Postgres free to
        // return two rows in either order between two pages: offset pagination then
        // repeats one and skips the other. The id breaks the tie.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        ...paginationMeta(total, page, limit),
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
      throw refusal(
        REFUSAL_CODES.applicationNotPending,
        "Only pending applications can be edited",
      );
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
      throw refusal(
        REFUSAL_CODES.applicationNotShortlistable,
        "Only pending applications can be shortlisted",
      );
    }

    const updated = await this.prisma.application.update({
      where: { id },
      data: { status: "SHORTLISTED", respondedAt: new Date() },
    });

    return toApplicationDto(updated);
  }

  /**
   * Loads an application and settles who is allowed to decide on it, with one
   * rule for the answer.
   *
   * Two statuses, because they answer different questions. A caller who is
   * neither the applicant nor the listing's owner is told the application does
   * not exist: they have no business knowing that it does. A caller who *is* one
   * of the two, but is not the one whose turn it is, is told 403 — they already
   * know the application exists, since it is theirs.
   *
   * The rule was written out in `reject` and `withdraw` and re-derived in
   * `accept`, which folded the two cases together and answered 404 to an applicant
   * asking to accept their own application — the one caller who plainly knew it
   * was there. `REFUSAL_CODES.applicationNotListingOwner` was written for the
   * answer and never used.
   */
  private async loadForDecision(
    tx: Prisma.TransactionClient,
    id: string,
    userId: string,
    required: "isOwner" | "isApplicant",
  ) {
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
    if (required === "isOwner" && !isOwner) {
      throw new ForbiddenException();
    }
    if (required === "isApplicant" && !isApplicant) {
      throw new ForbiddenException();
    }

    return { application, listing, isOwner, isApplicant };
  }

  async accept(id: string, userId: string) {
    const accepted = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const { application, listing } = await this.loadForDecision(
          tx,
          id,
          userId,
          "isOwner",
        );

        if (!listing) {
          // Unreachable, and the compiler cannot see why: ownership was
          // required above, and that is `listing?.createdById` compared to the
          // caller, so a listing that does not exist cannot have produced it.
          throw new NotFoundException(`Application ${id} not found`);
        }

        if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
          throw refusal(
            REFUSAL_CODES.applicationNotAcceptable,
            "Only pending or shortlisted applications can be accepted",
          );
        }
        if (isTerminalListingStatus(listing.status)) {
          throw refusal(
            REFUSAL_CODES.applicationListingNotAccepting,
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
            decisionSource: "PRACTICE_REJECTED",
            rejectionReason:
              PLATFORM_REJECTION_REASONS.anotherCandidateRetained,
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
        const { application } = await this.loadForDecision(
          tx,
          id,
          userId,
          "isOwner",
        );

        if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
          throw refusal(
            REFUSAL_CODES.applicationNotRejectable,
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
        const { application } = await this.loadForDecision(
          tx,
          id,
          userId,
          "isApplicant",
        );

        if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
          throw refusal(
            REFUSAL_CODES.applicationNotWithdrawable,
            "Only pending or shortlisted applications can be withdrawn",
          );
        }

        const updated = await tx.application.update({
          where: { id },
          data: {
            status: "WITHDRAWN",
            decisionSource: "CANDIDATE_WITHDREW",
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
