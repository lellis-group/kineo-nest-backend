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
import { toProfileDto } from "./profile.mapper";

/**
 * The conflict a unique constraint names, translated.
 *
 * A `P2002` reaches these routes through two different races: the pre-check and
 * the `create`/`update` can both lose, and they lose on *different* keys —
 * `userId` is the profile-per-user rename of the user who double submitted,
 * `rppsNumber` is a number somebody registered with in between. The old answer
 * named `RPPS number` for both, which told a racing caller their profile
 * exists while every retry answered "RPPS in use".
 */
function p2002Message(error: unknown): string | undefined {
  if (
    !(
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
  ) {
    return undefined;
  }

  const target = (error.meta as { target?: string[] | string } | undefined)
    ?.target;
  const fields = Array.isArray(target) ? target : [target ?? ""];
  if (fields.includes("userId")) {
    return "Profile already exists for this user";
  }
  return "RPPS number already in use";
}

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
      const created = await this.prisma.profile.create({
        data: { ...createProfileDto, userId },
      });
      return toProfileDto(created);
    } catch (error) {
      const message = p2002Message(error);
      if (message) {
        throw new ConflictException(message);
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
      data: data.map(toProfileDto),
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

    return toProfileDto(profile);
  }

  async findByUserId(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId } });

    if (!profile) {
      throw new NotFoundException("No profile found for this user");
    }

    return toProfileDto(profile);
  }

  /**
   * Writes the fields an owner may edit, and nothing else.
   *
   * The read answers 404 and 403 for the ordinary case, but it answers from
   * before the write: a profile deleted in between made the plain `update`
   * throw a raw P2025 at the default filter — a 500 nobody could act on. The
   * write carries the ownership itself, so a row that vanished answers 404.
   */
  async update(id: string, userId: string, updateProfileDto: UpdateProfileDto) {
    const profile = await this.findOne(id, userId);

    if (profile.userId !== userId) {
      throw new ForbiddenException();
    }

    try {
      const updated = await this.prisma.profile.updateMany({
        where: { id, userId },
        data: updateProfileDto,
      });

      if (updated.count === 0) {
        throw new NotFoundException(`Profile ${id} not found`);
      }

      const saved = await this.prisma.profile.findUnique({ where: { id } });

      if (!saved) {
        throw new NotFoundException(`Profile ${id} not found`);
      }

      return toProfileDto(saved);
    } catch (error) {
      const message = p2002Message(error);
      if (message) {
        throw new ConflictException(message);
      }
      throw error;
    }
  }

  /**
   * Deletes a profile, unless a cascade would take somebody else's application.
   *
   * One serializable transaction: the ownership read, the count and the delete ran
   * on thle, unless a cascade would take somebody else's application.
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

      const deleted = await tx.profile.delete({ where: { id } });
      return toProfileDto(deleted);
    });
  }
}
