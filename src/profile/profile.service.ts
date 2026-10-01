import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertNoThirdPartyApplications,
  PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
} from "../common/application-guard";
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
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

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
        // This list had no `orderBy` at all, which is the strongest form of the
        // unstable-pagination problem the other five endpoints had: the
        // database is free to return any order it likes on each call, so
        // paging through the results can repeat a profile and skip another.
        // `createdAt` alone still leaves ties, hence the `id`.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.profile.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
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

  async remove(id: string, userId: string) {
    const profile = await this.findOne(id, userId);

    if (profile.userId !== userId) {
      throw new ForbiddenException();
    }

    await assertNoThirdPartyApplications(
      this.prisma,
      id,
      { OR: [{ createdById: id }, { practice: { ownerId: id } }] },
      PROFILE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
    );

    return this.prisma.profile.delete({ where: { id } });
  }
}
