import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootApp,
  resetData,
  shutdownApp,
} from "../../account-deletion/e2e/harness";
import type { PrismaService } from "../../prisma.service";
import type { FindPracticesDto } from "../dto/find-practices.dto";
import type { PracticesService } from "../practices.service";

/**
 * Geographic practice search, against a real database.
 *
 * These assertions exist because the distance comparison used to happen in JS
 * on a bounded candidate set, where three properties were unavailable: the
 * `name` and `city` filters, an ordering that put the nearest first, and a
 * `total` that counted the whole match rather than the page. Each was a
 * plausible-looking answer, so none of them failed a unit test.
 */

let fx: Awaited<ReturnType<typeof bootApp>>;
let service: PracticesService;

const OWNER = "geo-owner";
const CENTRE = { lat: 48.8566, lng: 2.3522 };

/** Places a fixture `northKm` kilometres north of the centre. */
function northOf(northKm: number) {
  return {
    latitude: CENTRE.lat + northKm / 111.32,
    longitude:
      CENTRE.lng + northKm / (111.32 * Math.cos((CENTRE.lat * Math.PI) / 180)),
  };
}

async function seed(...rows: Array<[string, string, string, number]>) {
  await resetData(fx.prisma);
  await fx.prisma.user.create({
    data: { id: OWNER, email: "geo@x.test", emailVerified: true },
  });
  await fx.prisma.profile.create({
    data: {
      id: OWNER,
      userId: OWNER,
      specialty: "GENERALIST",
      profileType: "BOTH",
    },
  });

  for (const [id, name, city, northKm] of rows) {
    await fx.prisma.practice.create({
      data: {
        id,
        ownerId: OWNER,
        name,
        address: "1 rue",
        city,
        ...northOf(northKm),
      },
    });
  }
}

const near = (overrides: Partial<FindPracticesDto> = {}) => ({
  lat: CENTRE.lat,
  lng: CENTRE.lng,
  radiusKm: 10,
  page: 1,
  limit: 20,
  ...overrides,
});

beforeAll(async () => {
  fx = await bootApp();
  const { PracticesService } = await import("../practices.service");
  const { ConfigService } = await import("@nestjs/config");
  service = new PracticesService(
    fx.prisma as unknown as PrismaService,
    new ConfigService({}),
  );
});

afterAll(async () => {
  await shutdownApp();
});

describe("GET /practices (geographic search)", () => {
  it("returns the practices inside the radius, nearest first", async () => {
    await seed(
      ["A", "Practice A", "Paris", 1],
      ["B", "Practice B", "Paris", 3],
      ["C", "Practice C", "Paris", 5],
      ["D", "Practice D", "Lyon", 30],
    );

    const result = await service.findAll(near());

    // D sits 30 km out and must not appear.
    expect(result.data.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expect(result.meta.total).toBe(3);
  });

  it("applies the city filter", async () => {
    await seed(["A", "Practice A", "Paris", 1], ["B", "Practice B", "Lyon", 2]);

    const result = await service.findAll(near({ city: "paris" }));

    // Lowercase on purpose: the filter is case-insensitive, as it is on the
    // non-geographic path.
    expect(result.data.map((p) => p.id)).toEqual(["A"]);
    expect(result.meta.total).toBe(1);
  });

  it("applies the name filter", async () => {
    await seed(
      ["A", "Clinique des Lilas", "Paris", 1],
      ["B", "Practice B", "Paris", 2],
    );

    const result = await service.findAll(near({ name: "lilas" }));

    expect(result.data.map((p) => p.id)).toEqual(["A"]);
  });

  it("combines the radius with the filters", async () => {
    await seed(
      ["A", "Practice A", "Paris", 1],
      ["B", "Practice B", "Lyon", 2],
      ["C", "Practice C", "Paris", 40],
    );

    const result = await service.findAll(near({ city: "Paris" }));

    // C is in the right city but out of range.
    expect(result.data.map((p) => p.id)).toEqual(["A"]);
  });

  it("counts every match, not the page", async () => {
    await seed(
      ["A", "Practice A", "Paris", 1],
      ["B", "Practice B", "Paris", 2],
      ["C", "Practice C", "Paris", 3],
      ["D", "Practice D", "Paris", 4],
    );

    const result = await service.findAll(near({ limit: 2 }));

    expect(result.data).toHaveLength(2);
    expect(result.meta.total).toBe(4);
    expect(result.meta.totalPages).toBe(2);
  });

  it("pages without repeating or skipping a row", async () => {
    await seed(
      ["A", "Practice A", "Paris", 1],
      ["B", "Practice B", "Paris", 2],
      ["C", "Practice C", "Paris", 3],
    );

    const first = await service.findAll(near({ limit: 2, page: 1 }));
    const second = await service.findAll(near({ limit: 2, page: 2 }));

    expect(first.data.map((p) => p.id)).toEqual(["A", "B"]);
    expect(second.data.map((p) => p.id)).toEqual(["C"]);
  });

  it("hides a practice that is not public", async () => {
    await seed(["A", "Practice A", "Paris", 1]);
    await fx.prisma.practice.update({
      where: { id: "A" },
      data: { isPublic: false },
    });

    const result = await service.findAll(near());

    expect(result.meta.total).toBe(0);
  });

  it("treats a LIKE wildcard in the term as a literal character", async () => {
    await seed(
      ["PCT", "100% discount clinic", "Paris", 1],
      ["A", "Practice A", "Paris", 2],
    );

    const literal = await service.findAll(near({ name: "100%" }));
    expect(literal.data.map((p) => p.id)).toEqual(["PCT"]);

    // Read as a wildcard, this would match every practice in the radius.
    const underscore = await service.findAll(near({ name: "Practice_" }));
    expect(underscore.meta.total).toBe(0);
  });

  it("does not let a term break out of the pattern", async () => {
    await seed(
      ["Q", "O'Neill clinic", "Paris", 1],
      ["A", "Practice A", "Paris", 2],
    );

    const result = await service.findAll(near({ name: "O'Neill" }));

    expect(result.data.map((p) => p.id)).toEqual(["Q"]);
  });
});
