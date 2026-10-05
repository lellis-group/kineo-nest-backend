import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertNoThirdPartyApplications,
  ownedListingsFilter,
} from "../common/application-guard";
import { paginate, paginationMeta } from "../common/pagination";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { CreateProfileDto } from "./dto/create-profile.dto";
import { FindProfilesDto } from "./dto/find-profiles.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";

@Injectable()
export class ProfileService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, createProfileDto: CreateProfileDto) {
    const existing = await this.prisma.profile.findUnique({
      where: { userId },
    });

    if (existing) {
      throw new ConflictException("Profile already exists for this user");
    }

    try {
      return await this.prisma.profile.create({
        data: { ...createProfileDto, userId },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("RPPS number already in use");
      }
      throw error;
    }
  }

  async findAll(filters: FindProfilesDto) {
    const { page, limit, skip } = paginate(filters);
    const where = {
      isPublic: true,
      specialty: filters.specialty,
      profileType: filters.profileType,
      city: filters.city,
    };

    const [data, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.profile.count({ where }),
    ]);

    return {
      data,
      meta: paginationMeta(total, page, limit),
    };
  }

  async findOne(id: string, requesterUserId?: string) {
    const profile = await this.prisma.profile.findUnique({ where: { id } });

    if (!profile) {
      throw new NotFoundException(`Profile ${id} not found`);
    }

    if (!profile.isPublic && profile.userId !== requesterUserId) {
      throw new NotFoundException(`Profile ${id} not found`);
    }

    return profile;
  }

  async findByUserId(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId } });

    if (!profile) {
      throw new NotFoundException("No profile found for this user");
    }

    return profile;
  }

  async update(id: string, userId: string, updateProfileDto: UpdateProfileDto) {
    const profile = await this.findOne(id, userId);

    if (profile.userId !== userId) {
      throw new ForbiddenException();
    }

    try {
      return await this.prisma.profile.update({
        where: { id },
        data: updateProfileDto,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("RPPS number already in use");
      }
      throw error;
    }
  }

  /**
   * Deletes a profile, unless a cascade would take somebody else's application.
   *
   * One serializable transaction: the ownership read, the count and the delete ran
   * on three connections, so an application committed in the gap was invisible to
   * the guard and went with the cascade.
   */
  async remove(id: string, userId: string) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const profile = await tx.profile.findUnique({ where: { id } });

      if (!profile) {
        throw new NotFoundException(`Profile ${id} not found`);
      }

      if (profile.userId !== userId) {
        throw new ForbiddenException();
      }

      // Scoped to the listings this profile owns, directly or through its
      // practices, as the practice and listing deletes are. Without the filter the
      // guard counts every application on every listing in the platform, and
      // refuses this deletion because someone else — anywhere — applied to
      // something.
      await assertNoThirdPartyApplications(tx, id, ownedListingsFilter(id));

      return tx.profile.delete({ where: { id } });
    });
  }
}
