import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  getOwnedProfileId,
  getOwnedProfileIdSafe,
} from "../common/profile-lookup";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { PrismaService } from "../prisma.service";
import { CreatePracticeDto } from "./dto/create-practice.dto";
import type { FindPracticesDto } from "./dto/find-practices.dto";
import { UpdatePracticeDto } from "./dto/update-practice.dto";

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
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

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
          longitude: {
            not: null,
            gte: lng - longitudeDelta,
            lte: lng + longitudeDelta,
          },
        },
        take: MAX_GEO_CANDIDATES,
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
        .sort((left, right) => left.distance - right.distance);

      const total = practices.length;

      return {
        data: practices
          .slice(skip, skip + limit)
          .map(({ practice }) => practice),
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }

    const where = {
      isPublic: true,
      ...(name && { name: { contains: name, mode: "insensitive" as const } }),
      ...(city && { city: { contains: city, mode: "insensitive" as const } }),
    };

    const [data, total] = await Promise.all([
      this.prisma.practice.findMany({ where, skip, take: limit }),
      this.prisma.practice.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
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

  async remove(id: string, userId: string) {
    const practice = await this.findOne(id, userId);
    const ownerId = await getOwnedProfileId(this.prisma, userId);

    if (practice.ownerId !== ownerId) {
      throw new ForbiddenException();
    }

    return this.prisma.practice.delete({ where: { id } });
  }
}
