import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  assertNoThirdPartyApplications,
  PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
} from "../common/application-guard";
import { paginate, paginationMeta } from "../common/pagination";
import {
  getOwnedProfileId,
  getOwnedProfileIdSafe,
} from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { PrismaService } from "../prisma.service";
import { CreatePracticeDto } from "./dto/create-practice.dto";
import type { FindPracticesDto } from "./dto/find-practices.dto";
import { UpdatePracticeDto } from "./dto/update-practice.dto";
import { longitudeRanges } from "./longitude-range";

const EARTH_RADIUS_KM = 6_371;
const MAX_GEO_CANDIDATES = 500;

@Injectable()
export class PracticesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, createPracticeDto: CreatePracticeDto) {
    const ownerId = await getOwnedProfileId(this.prisma, userId);
    const maxPractices = this.config.get<number>("limits.practicesPerProfile");
    return runSerializableTransaction(this.prisma, async (tx) => {
      if (maxPractices) {
        const count = await tx.practice.count({ where: { ownerId } });
        if (count >= maxPractices) {
          throw new BadRequestException(
            `You cannot create more than ${maxPractices} practices`,
          );
        }
      }

      return tx.practice.create({ data: { ...createPracticeDto, ownerId } });
    });
  }

  async findAll(filters: FindPracticesDto) {
    const { name, city, lat, lng, radiusKm } = filters;
    const { page, limit, skip } = paginate(filters);
    if (lat !== undefined && lng !== undefined && radiusKm !== undefined) {
      const latitudeDelta = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
      const longitudeDelta =
        latitudeDelta / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);

      const candidates = await this.prisma.practice.findMany({
        where: {
          isPublic: true,
          latitude: {
            not: null,
            gte: lat - latitudeDelta,
            lte: lat + latitudeDelta,
          },
          longitude: { not: null },
          // The same two text filters the non-geographic path applies. They used
          // to be missing here, silently: `?city=Lyon` with coordinates returned
          // every public practice inside the box, because nothing read the
          // parameter.
          ...(name && {
            name: { contains: name, mode: "insensitive" as const },
          }),
          ...(city && {
            city: { contains: city, mode: "insensitive" as const },
          }),
          // The ranges are alternatives, so they need OR rather than AND — and
          // OR at the top level, because Prisma does not accept it inside a
          // scalar field filter. Neither mistake is visible to the compiler: the
          // first returns every practice within reach of no interval at all, the
          // second is rejected outright by the query.
          OR: longitudeRanges(lng, longitudeDelta).map((range) => ({
            longitude: range,
          })),
        },
        take: MAX_GEO_CANDIDATES,
        orderBy: [{ id: "desc" }],
      });

      const located = candidates.filter(
        (
          practice,
        ): practice is typeof practice & {
          latitude: number;
          longitude: number;
        } => practice.latitude !== null && practice.longitude !== null,
      );

      const practices = located
        .map((practice) => ({
          practice,
          distance: this.distanceInKm(
            lat,
            lng,
            practice.latitude,
            practice.longitude,
          ),
        }))
        .filter(({ distance }) => distance <= radiusKm)
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.practice.id.localeCompare(right.practice.id),
        );

      const total = practices.length;

      return {
        data: practices
          .slice(skip, skip + limit)
          .map(({ practice }) => practice),
        meta: paginationMeta(total, page, limit),
      };
    }

    const where = {
      isPublic: true,
      ...(name && { name: { contains: name, mode: "insensitive" as const } }),
      ...(city && { city: { contains: city, mode: "insensitive" as const } }),
    };

    const [data, total] = await Promise.all([
      this.prisma.practice.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.practice.count({ where }),
    ]);

    return {
      data,
      meta: paginationMeta(total, page, limit),
    };
  }

  private distanceInKm(lat1: number, lng1: number, lat2: number, lng2: number) {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const latitudeDelta = toRadians(lat2 - lat1);
    const longitudeDelta = toRadians(lng2 - lng1);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(longitudeDelta / 2) ** 2;

    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(haversine));
  }

  async findMine(userId: string) {
    const ownerId = await getOwnedProfileId(this.prisma, userId);

    return this.prisma.practice.findMany({ where: { ownerId } });
  }

  async findOne(id: string, requesterUserId?: string) {
    const practice = await this.prisma.practice.findUnique({ where: { id } });

    if (!practice) {
      throw new NotFoundException(`Practice ${id} not found`);
    }

    if (!practice.isPublic) {
      const ownerId = await getOwnedProfileIdSafe(this.prisma, requesterUserId);

      if (ownerId !== practice.ownerId) {
        throw new NotFoundException(`Practice ${id} not found`);
      }
    }

    return practice;
  }

  async update(
    id: string,
    userId: string,
    updatePracticeDto: UpdatePracticeDto,
  ) {
    const practice = await this.findOne(id, userId);
    const ownerId = await getOwnedProfileId(this.prisma, userId);

    if (practice.ownerId !== ownerId) {
      throw new ForbiddenException();
    }

    return this.prisma.practice.update({
      where: { id },
      data: updatePracticeDto,
    });
  }

  /**
   * Deletes a practice, unless a cascade would take somebody else's application.
   *
   * One serializable transaction, like the listing and profile deletes: read,
   * count and delete on three connections let an application committed in the gap
   * slip past the count and go with the cascade.
   */
  async remove(id: string, userId: string) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const practice = await tx.practice.findUnique({ where: { id } });
      if (!practice) {
        throw new NotFoundException(`Practice ${id} not found`);
      }

      const ownerId = await getOwnedProfileId(tx, userId);

      if (practice.ownerId !== ownerId) {
        throw new ForbiddenException();
      }

      // This practice only, not its owner's others. The filter used to be
      // `{ practice: { ownerId } }`, so deleting one location was refused because a
      // *different* row of the same owner carried somebody's application — and a
      // practice with several locations could not lose any one of them until every
      // one of them was empty.
      await assertNoThirdPartyApplications(
        tx,
        ownerId,
        { practiceId: id },
        PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
      );

      return tx.practice.delete({ where: { id } });
    });
  }
}
