/**
 * A practice belongs to a profile, and its own reads — the directory, `/mine`,
 * the write — were the only serialized routes with no e2e coverage at all.
 *
 * `geo-search` covers the radius read, which is the hard part; nothing covered
 * the rest. So the guards were unproven (`/mine` for a user with no profile, a
 * private practice read from outside, an update by someone who does not own it),
 * and so was the practice's own placement rule: a listing hangs on a practice,
 * and a practice whose coordinates cannot be placed is a listing the map cannot
 * draw. That pairing is asserted here, since it is the only place both halves
 * exist together.
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
  createVerifiedUser,
  type E2EFixture,
  resetData,
  shutdownApp,
  signIn,
} from "../../common/e2e/harness";

const PASSWORD = "Password123!";

// The quota test below counts against a cap that has to hold in every
// environment, the developer's `.env` included: set before the application is
// imported and its configuration frozen.
process.env.MAX_PRACTICES_PER_PROFILE = "2";

let fx: E2EFixture;

interface SeededOwner {
  cookies: string;
  profileId: string;
}

async function seedOwner(): Promise<SeededOwner> {
  const user = await createVerifiedUser(
    fx.prisma,
    `user-${crypto.randomUUID()}`,
    `owner-${crypto.randomUUID()}@practice.test`,
    PASSWORD,
  );
  const profile = await fx.prisma.profile.create({
    data: {
      userId: user.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      isPublic: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return {
    profileId: profile.id,
    cookies: await signIn(fx.baseUrl, user.email, PASSWORD),
  };
}

async function createPractice(
  cookies: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await request(fx.baseUrl)
    .post("/practices")
    .set("Cookie", cookies)
    .send({
      name: "Cabinet Medical",
      address: "1 rue de la Paix",
      city: "Lyon",
      ...overrides,
    });

  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
  };
}

beforeAll(async () => {
  fx = await bootApp();
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
});

describe("creating a practice", () => {
  it("answers the practice it wrote, owner attached and coordinates kept", async () => {
    const owner = await seedOwner();

    const { status, body } = await createPractice(owner.cookies, {
      latitude: 45.75,
      longitude: 4.85,
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      name: "Cabinet Medical",
      address: "1 rue de la Paix",
      city: "Lyon",
      latitude: 45.75,
      longitude: 4.85,
      isPublic: true,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");

    const stored = await fx.prisma.practice.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(stored.ownerId).toBe(owner.profileId);
  });

  it("stores a practice with no coordinates, rather than at zero zero", async () => {
    const owner = await seedOwner();

    const { body } = await createPractice(owner.cookies);

    // Zero, zero is the Atlantic off Africa: a practice written there by
    // default would put a pin in the ocean on the map.
    expect(body.latitude).toBeNull();
    expect(body.longitude).toBeNull();
  });

  it("refuses a latitude without its longitude", async () => {
    const owner = await seedOwner();

    const { status } = await createPractice(owner.cookies, { latitude: 45.75 });

    expect(status).toBe(400);
  });

  it("refuses a practice past the profile's quota", async () => {
    const owner = await seedOwner();

    expect((await createPractice(owner.cookies)).status).toBe(201);
    expect((await createPractice(owner.cookies)).status).toBe(201);

    const third = await createPractice(owner.cookies);

    expect(third.status).toBe(400);
    expect(String(third.body.message)).toContain("more than 2");
    // Counted per owner: the reset leaves the system's own scaffold rows in
    // place, and this profile's quota is not their business.
    expect(
      await fx.prisma.practice.count({ where: { ownerId: owner.profileId } }),
    ).toBe(2);
  });

  it("refuses a user who has no profile yet", async () => {
    const user = await createVerifiedUser(
      fx.prisma,
      "user-noprofile",
      "noprofile@practice.test",
      PASSWORD,
    );
    const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

    const { status } = await createPractice(cookies);

    expect(status).toBe(404);
  });
});

describe("reading practices", () => {
  it("lists the caller's own practices, and nothing else", async () => {
    const owner = await seedOwner();
    const mine = await createPractice(owner.cookies);
    const other = await seedOwner();
    await createPractice(other.cookies);

    const response = await request(fx.baseUrl)
      .get("/practices/mine")
      .set("Cookie", owner.cookies);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ id: mine.body.id as string });
  });

  it("answers the caller's own practices as an empty list, not 404, without any", async () => {
    const owner = await seedOwner();

    const response = await request(fx.baseUrl)
      .get("/practices/mine")
      .set("Cookie", owner.cookies);

    // No practice yet is an empty practice list, not a missing resource: the
    // dashboard asks this on every load, long before it asks for anything.
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("404s /mine to a caller with no profile", async () => {
    const user = await createVerifiedUser(
      fx.prisma,
      "user-noprofile-2",
      "noprofile2@practice.test",
      PASSWORD,
    );
    const cookies = await signIn(fx.baseUrl, user.email, PASSWORD);

    const response = await request(fx.baseUrl)
      .get("/practices/mine")
      .set("Cookie", cookies);

    expect(response.status).toBe(404);
  });

  it("reads one public practice, and 404s a private one from outside", async () => {
    const owner = await seedOwner();
    const publicPractice = await createPractice(owner.cookies, {
      name: "Cabinet Ouvert",
    });
    const privatePractice = await createPractice(owner.cookies, {
      name: "Cabinet Ferme",
      isPublic: false,
    });

    const opened = await request(fx.baseUrl).get(
      `/practices/${publicPractice.body.id}`,
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      name: "Cabinet Ouvert",
      isPublic: true,
    });

    const stranger = await seedOwner();
    const closed = await request(fx.baseUrl)
      .get(`/practices/${privatePractice.body.id}`)
      .set("Cookie", stranger.cookies);
    expect(closed.status).toBe(404);

    // The owner still reads their own private practice: a practice going private
    // hides it from the directory, not from the practice itself.
    const toOwner = await request(fx.baseUrl)
      .get(`/practices/${privatePractice.body.id}`)
      .set("Cookie", owner.cookies);
    expect(toOwner.status).toBe(200);
  });
});

describe("editing a practice", () => {
  it("writes the change and answers the practice that was written", async () => {
    const owner = await seedOwner();
    const created = await createPractice(owner.cookies);

    const response = await request(fx.baseUrl)
      .patch(`/practices/${created.body.id as string}`)
      .set("Cookie", owner.cookies)
      .send({ city: "Grenoble", latitude: 45.1885, longitude: 5.7245 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: created.body.id as string,
      city: "Grenoble",
      latitude: 45.1885,
      longitude: 5.7245,
    });

    const stored = await fx.prisma.practice.findUniqueOrThrow({
      where: { id: created.body.id as string },
    });
    expect(stored.city).toBe("Grenoble");
  });

  it("a practice placed by its own update puts its postings on the map", async () => {
    const owner = await seedOwner();
    const created = await createPractice(owner.cookies);

    // Unplaced: the map answers it as unlocated rather than pretending.
    const listing = await fx.prisma.replacementListing.create({
      data: {
        practiceId: created.body.id as string,
        createdById: owner.profileId,
        title: "Remplacement",
        startDate: new Date("2026-11-02"),
        endDate: new Date("2026-11-16"),
        specialty: "GENERALIST",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const before = await request(fx.baseUrl).get(
      "/replacement-listings/places",
    );
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      places: [],
      unlocated: 1,
      totalPlaces: 0,
    });

    await request(fx.baseUrl)
      .patch(`/practices/${created.body.id as string}`)
      .set("Cookie", owner.cookies)
      .send({ latitude: 45.1885, longitude: 5.7245 });

    // Same practice, same posting, one write apart: the coordinates a practice
    // gains are what make its postings drawable, and only a real read of both
    // halves proves the pairing holds.
    const after = await request(fx.baseUrl).get("/replacement-listings/places");
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      unlocated: 0,
      totalPlaces: 1,
      truncated: false,
    });
    expect(after.body.places[0]).toMatchObject({
      practiceId: created.body.id as string,
      count: 1,
    });
    expect(after.body.places[0].listings[0]).toMatchObject({
      id: listing.id,
    });
  });

  it("refuses someone else's practice", async () => {
    const owner = await seedOwner();
    const created = await createPractice(owner.cookies);
    const stranger = await seedOwner();

    const response = await request(fx.baseUrl)
      .patch(`/practices/${created.body.id as string}`)
      .set("Cookie", stranger.cookies)
      .send({ city: "Elsewhere" });

    expect(response.status).toBe(403);
    const stored = await fx.prisma.practice.findUniqueOrThrow({
      where: { id: created.body.id as string },
    });
    expect(stored.city).toBe("Lyon");
  });

  it("refuses to drop one coordinate of a placed practice", async () => {
    const owner = await seedOwner();
    const created = await createPractice(owner.cookies, {
      latitude: 45.75,
      longitude: 4.85,
    });

    const { status } = await request(fx.baseUrl)
      .patch(`/practices/${created.body.id as string}`)
      .set("Cookie", owner.cookies)
      .send({ latitude: null });

    expect(status).toBe(400);
  });

  it("404s an unknown practice", async () => {
    const owner = await seedOwner();

    const response = await request(fx.baseUrl)
      .patch("/practices/does-not-exist")
      .set("Cookie", owner.cookies)
      .send({ city: "Elsewhere" });

    expect(response.status).toBe(404);
  });
});
