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

async function seedPractice(id: string, latitude: number, longitude: number) {
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
      name: `Practice ${id}`,
      address: "1 rue",
      city: "Test",
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
  { limit = "50", page = "1" }: { limit?: string; page?: string } = {},
) {
  const response = await request(fx.baseUrl)
    .get("/practices")
    .query({
      lat: String(lat),
      lng: String(lng),
      radiusKm: String(radiusKm),
      limit,
      page,
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

  it("counts the same population it returns", async () => {
    await seedPractice("east", 0, 179.8);
    await seedPractice("west", 0, -179.8);

    const body = await search(0, 179.9, 100);

    expect(body.meta.total).toBe(body.data.length);
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
