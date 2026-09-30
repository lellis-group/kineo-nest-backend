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

const EARTH_RADIUS_KM = 6_371;

const BACKSLASH = "'\\'";

/**
 * Haversine distance, in kilometres, from the given centre to the coordinates
 * of the `practice` row, as a parameterised SQL expression.
 *
 * The centre coordinates are interpolated by Prisma rather than inlined, so no
 * caller input is ever concatenated into the statement. Every parameter lands
 * in a numeric position, which is where Postgres applies its own typing.
 */
function haversineKm(lat: number, lng: number) {
  // The centre is converted here, and only the *difference* is computed in
  // SQL. Rounding the centre separately from the column would put radians on
  // one side of the subtraction and degrees on the other, which silently
  // yields thousands of kilometres rather than raising anything.
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  // Column names cannot be bound as values: a placeholder there would arrive
  // where the parser expects a column. They are literals from this file, never
  // caller input, so inlining them adds no injection surface.
  const colLat = Prisma.raw('p."latitude"');
  const colLng = Prisma.raw('p."longitude"');

  return Prisma.sql`(
    ${EARTH_RADIUS_KM} * 2 * asin(
      sqrt(
        power(sin(radians(${colLat}) - ${latRad}) / 2, 2)
        + ${cosLat} * cos(radians(${colLat})) * power(sin(radians(${colLng}) - ${lngRad}) / 2, 2)
      )
    )
  )`;
}

/**
 * A case-insensitive "contains" predicate on a column.
 *
 * escapeLike neutralises the wildcards the term happens to contain — a search
 * for "100%" or "a_b" must not match everything — and the matching ESCAPE
 * clause tells Postgres to honour those backslashes. The escape character has
 * to be a SQL literal: bound as a parameter it would arrive as a value, and
 * ESCAPE rejects anything but a one-character string literal.
 */
function containsInsensitive(column: '"name"' | '"city"', term: string) {
  return Prisma.sql`p.${Prisma.raw(column)} ILIKE ${`%${escapeLike(term)}%`} ESCAPE ${Prisma.raw(BACKSLASH)}`;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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
      return this.findAllNear({
        name,
        city,
        lat,
        lng,
        radiusKm,
        page,
        limit,
        skip,
      });
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
        // Without a total order the database is free to return a different
        // slice on each call, so page 2 could repeat rows from page 1 and drop
        // others. `id` breaks the ties `createdAt` leaves.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.practice.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Geographic search.
   *
   * Distance is computed in SQL rather than in JS on a bounded candidate set.
   * The previous version capped the candidates it fetched and had no
   * `orderBy`, so it filtered and sorted them in memory and sliced the result:
   * past the cap it returned an arbitrary subset rather than the nearest,
   * reported that subset's length as `total` (so `totalPages` was wrong), and —
   * because it built its own `where` — silently ignored the `name` and `city`
   * filters the DTO had already validated. All three are properties of doing the
   * distance comparison outside the database, so the comparison moves in.
   *
   * The bounding box still narrows the rows Postgres has to score, and the
   * exact haversine predicate is applied on top of it.
   */
  private async findAllNear(filters: {
    name?: string;
    city?: string;
    lat: number;
    lng: number;
    radiusKm: number;
    page: number;
    limit: number;
    skip: number;
  }) {
    const { name, city, lat, lng, radiusKm, page, limit, skip } = filters;

    const latitudeDelta = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
    // Near the poles the longitude window widens without bound as cos(lat)
    // approaches 0. Clamping to the whole range is honest there: the exact
    // haversine predicate below discards what does not belong.
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const longitudeDelta =
      Math.abs(cosLat) < 1e-6 ? 180 : latitudeDelta / Math.abs(cosLat);

    // `Prisma.sql` values are consumed as they are interpolated, so the same
    // fragment cannot be embedded in two statements. A builder, not a value.
    const whereClause = () =>
      Prisma.sql`
        p."isPublic" = true
        AND p."latitude" IS NOT NULL
        AND p."longitude" IS NOT NULL
        AND p."latitude" BETWEEN ${lat - latitudeDelta} AND ${lat + latitudeDelta}
        AND p."longitude" BETWEEN ${lng - longitudeDelta} AND ${lng + longitudeDelta}
        AND ${haversineKm(lat, lng)} <= ${radiusKm}
        ${
          name
            ? Prisma.sql`AND ${containsInsensitive('"name"', name)}`
            : Prisma.empty
        }
        ${
          city
            ? Prisma.sql`AND ${containsInsensitive('"city"', city)}`
            : Prisma.empty
        }
      `;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ id: string; ownerId: string; name: string }>
      >(Prisma.sql`
        SELECT p."id", p."ownerId", p."name", p."address", p."city",
               p."latitude", p."longitude", p."isPublic", p."createdAt"
        FROM practice p
        WHERE ${whereClause()}
        ORDER BY ${haversineKm(lat, lng)} ASC, p."id" ASC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS total FROM practice p WHERE ${whereClause()}
      `),
    ]);

    const totalCount = Number(countRows[0]?.total ?? 0);

    return {
      data: rows,
      meta: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
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

  async remove(id: string, userId: string) {
    const practice = await this.findOne(id, userId);
    const ownerId = await getOwnedProfileId(this.prisma, userId);

    if (practice.ownerId !== ownerId) {
      throw new ForbiddenException();
    }

    await assertNoThirdPartyApplications(
      this.prisma,
      ownerId,
      { practiceId: id },
      PRACTICE_HAS_THIRD_PARTY_APPLICATIONS_MESSAGE,
    );

    return this.prisma.practice.delete({ where: { id } });
  }
}
