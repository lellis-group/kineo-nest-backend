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
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { CreatePracticeDto } from "./dto/create-practice.dto";
import type { FindPracticesDto } from "./dto/find-practices.dto";
import { UpdatePracticeDto } from "./dto/update-practice.dto";
import {
  geoWhere,
  haversineKm,
  PRACTICE_GEO_COLUMNS,
  type PracticeGeoRow,
} from "./geo-query";

const EARTH_RADIUS_KM = 6_371;

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
      // Near the poles the longitude window widens without bound as cos(lat)
      // approaches zero. Clamping to the whole globe is honest there, because the
      // exact haversine predicate discards whatever does not belong.
      const cosLat = Math.cos((lat * Math.PI) / 180);
      const longitudeDelta =
        Math.abs(cosLat) < 1e-6 ? 180 : latitudeDelta / Math.abs(cosLat);

      const where = geoWhere({
        lat,
        lng,
        radiusKm,
        latitudeDelta,
        longitudeDelta,
        name,
        city,
      });

      // Built per statement rather than once and shared. Reusing a fragment is
      // in fact safe — checked against this Prisma version, nested and with a
      // `raw` inside — but a function reads as what it is: the same predicate,
      // written out twice, from one definition.
      const [rows, counts] = await Promise.all([
        this.prisma.$queryRaw<PracticeGeoRow[]>(Prisma.sql`
          SELECT ${Prisma.raw(PRACTICE_GEO_COLUMNS)}
          FROM practice p
          WHERE ${where}
          ORDER BY ${haversineKm(lat, lng)} ASC, p."id" ASC
          LIMIT ${limit} OFFSET ${skip}
        `),
        this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS total FROM practice p WHERE ${where}
        `),
      ]);

      const total = Number(counts[0]?.total ?? 0);

      return {
        data: rows,
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
