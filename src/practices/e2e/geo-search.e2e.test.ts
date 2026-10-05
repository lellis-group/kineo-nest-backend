/**
 * The geo search over HTTP.
 *
 * A bounding box cannot wrap on its own: centred just west of the antimeridian it
 * asks for longitudes no stored value satisfies, so practices on the other side
 * disappear from the page *and* from the count, while the exact haversine
 * predicate says they were inside the radius. Only a real database and a real
 * query show that, which is why the unit test on the interval arithmetic is not
 * enough.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import request from "supertest";
import {
  bootApp,
  type E2EFixture,
  resetData,
  shutdownApp,
} from "../../common/e2e/harness";
import { SYSTEM_SCAFFOLD } from "../../common/system-scaffold";

let fx: E2EFixture;

async function seedPractice(
  id: string,
  latitude: number,
  longitude: number,
  { city = "Test", name }: { city?: string; name?: string } = {},
) {
  const { prisma } = fx;
  const now = new Date();

  await prisma.user.create({
    data: {
      id: `user-${id}`,
      email: `${id}@test.invalid`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.profile.create({
    data: {
      id: `profile-${id}`,
      userId: `user-${id}`,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.practice.create({
    data: {
      id,
      ownerId: `profile-${id}`,
      name: name ?? `Practice ${id}`,
      address: "1 rue",
      city,
      latitude,
      longitude,
      isPublic: true,
      createdAt: now,
    },
  });
}

async function search(
  lat: number,
  lng: number,
  radiusKm = 50,
  {
    limit = "50",
    page = "1",
    name,
    city,
  }: { limit?: string; page?: string; name?: string; city?: string } = {},
) {
  const response = await request(fx.baseUrl)
    .get("/practices")
    .query({
      lat: String(lat),
      lng: String(lng),
      radiusKm: String(radiusKm),
      limit,
      page,
      ...(name ? { name } : {}),
      ...(city ? { city } : {}),
    });

  expect(response.status).toBe(200);
  return response.body;
}

const ids = (body: { data: { id: string }[] }) =>
  body.data.map((practice) => practice.id);

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
});

describe("GET /practices around the antimeridian", () => {
  it("finds the practices on both sides of the line", async () => {
    await seedPractice("east", 0, 179.8);
    await seedPractice("west", 0, -179.8);
    await seedPractice("far", 0, 0);

    const body = await search(0, 179.9, 100);

    expect(ids(body)).toContain("east");
    expect(ids(body)).toContain("west");
    expect(ids(body)).not.toContain("far");
  });

  it("applies the city filter, which the geographic path used to ignore", async () => {
    // `?city=` was accepted by the DTO, validated, and then never read by the
    // geographic branch — so it returned every public practice in the box.
    await seedPractice("lyon", 0, 0, { city: "Lyon" });
    await seedPractice("marseille", 0, 0.02, { city: "Marseille" });

    const body = await search(0, 0, 50, { city: "Lyon" });

    expect(ids(body)).toEqual(["lyon"]);
    expect(body.meta.total).toBe(1);
  });

  it("applies the name filter too", async () => {
    await seedPractice("one", 0, 0, { name: "Cabinet Kennedy" });
    await seedPractice("two", 0, 0.01, { name: "Cabinet Pasteur" });

    const body = await search(0, 0, 50, { name: "kennedy" });

    expect(ids(body)).toEqual(["one"]);
    expect(body.meta.total).toBe(1);
  });

  it("combines the radius with the filters", async () => {
    await seedPractice("near", 0, 0, { city: "Lyon" });
    await seedPractice("far", 2, 0, { city: "Lyon" });

    const body = await search(0, 0, 50, { city: "Lyon" });

    expect(ids(body)).toEqual(["near"]);
  });

  it("counts the matches, not the page", async () => {
    // The previous assertion was `total === data.length`, and it held for the
    // wrong reason: both came out of the same capped array the service had
    // already sliced. This one puts 30 practices inside the radius and asks for 5.
    for (let i = 0; i < 30; i += 1) {
      await seedPractice(`many-${i}`, 0, i * 0.001);
    }

    const body = await search(0, 0, 100, { limit: "5" });

    expect(body.data).toHaveLength(5);
    expect(body.meta.total).toBe(30);
    expect(body.meta.totalPages).toBe(6);
  });

  it("honours the radius, not only the box", async () => {
    await seedPractice("near", 0, 179.95);
    await seedPractice("edge", 0.9, 179.8);

    const body = await search(0, 179.9, 30);

    expect(ids(body)).toContain("near");
    expect(ids(body)).not.toContain("edge");
  });
});

describe("GET /practices away from the edges", () => {
  it("returns the nearest, across more candidates than the old cap", async () => {
    // The old path fetched at most 500 candidates ordered by id and took the
    // nearest of *those*, so past 500 the reader got an arbitrary subset's
    // nearest. These are 510, deliberately in an order that puts the closest last
    // by id: a capped implementation returns "near-0" here.
    for (let i = 1; i <= 510; i += 1) {
      await seedPractice(`far-${i}`, 0, i * 0.001);
    }
    await seedPractice("near", 0, 0);

    const body = await search(0, 0, 100, { limit: "3" });

    expect(ids(body)).toEqual(["near", "far-1", "far-2"]);
    expect(body.meta.total).toBe(511);
  });

  it("pages without repeating or skipping a row", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedPractice(`p-${i}`, 0, i * 0.001);
    }

    const first = ids(await search(0, 0, 100, { limit: "5", page: "1" }));
    const second = ids(await search(0, 0, 100, { limit: "5", page: "2" }));
    const third = ids(await search(0, 0, 100, { limit: "5", page: "3" }));

    expect([...first, ...second, ...third]).toHaveLength(12);
    expect(new Set([...first, ...second, ...third]).size).toBe(12);
    // Nearest first throughout, so the ordering is the distance and not the id.
    expect(first[0]).toBe("p-0");
  });

  it("reads a LIKE wildcard as a literal character", async () => {
    await seedPractice("plain", 0, 0, { name: "Cabinet 100%" });
    await seedPractice("other", 0, 0.001, { name: "Cabinet Pasteur" });

    const body = await search(0, 0, 100, { name: "100%" });

    expect(ids(body)).toEqual(["plain"]);
  });

  it("does not let a term break out of the pattern", async () => {
    await seedPractice("plain", 0, 0, { name: "Cabinet Epsilon" });
    await seedPractice("other", 0, 0.001, { name: "Cabinet Zeta" });

    // Without the escaping this is a pattern that matches both, and with a naive
    // concatenation it would be a syntax error rather than a wrong answer.
    const body = await search(0, 0, 100, { name: "%" });

    expect(ids(body)).toEqual([]);
  });

  it("does not return the scaffold", async () => {
    await seedPractice("lyon", 45.75, 4.85);

    const body = await search(45.75, 4.85, 10);

    expect(ids(body)).toEqual(["lyon"]);
    expect(ids(body)).not.toContain(SYSTEM_SCAFFOLD.practiceId);
  });

  it("paginates a stable order, so two pages neither repeat nor skip", async () => {
    for (const index of [1, 2, 3, 4, 5]) {
      await seedPractice(`lyon-${index}`, 45.75 + index / 1000, 4.85);
    }

    const first = await search(45.75, 4.85, 50, { limit: "2", page: "1" });
    const second = await search(45.75, 4.85, 50, { limit: "2", page: "2" });

    expect(first.meta.total).toBe(5);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(4);
  });
});
