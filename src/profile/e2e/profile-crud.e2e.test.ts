/**
 * The profile is the first thing every authenticated user does, and every other
 * route depends on it existing: a listing hangs on a profile, a practice is
 * owned by one, an application is made by one.
 *
 * Which is why its absence from the e2e suites was the odd one out. The unit
 * spec drives the service with fakes, so every refusal in it — the second
 * profile, a private profile read from outside, someone else's update — was
 * proven against a fake rather than against the guard, the DTO validation and
 * the serializer wired together around it. And the profile is the resource whose
 * serializer publishes two different shapes from two different routes: `/me`
 * and the writes answer the full `Profile`, `/:id` answers the `PublicProfile`
 * with `userId` and `rppsNumber` withheld. That difference exists only in the
 * response, so only HTTP can show it.
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

let fx: E2EFixture;

interface Seeded {
  userId: string;
  email: string;
  cookies: string;
  profileId: string;
}

/** A user with no profile yet — the state `POST /profile` exists for. */
async function seedUser(): Promise<Seeded> {
  const user = await createVerifiedUser(
    fx.prisma,
    `user-${crypto.randomUUID()}`,
    `user-${crypto.randomUUID()}@profile.test`,
    PASSWORD,
  );

  return {
    userId: user.id,
    email: user.email,
    cookies: await signIn(fx.baseUrl, user.email, PASSWORD),
    profileId: "",
  };
}

async function createProfileOverHttp(
  cookies: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await request(fx.baseUrl)
    .post("/profile")
    .set("Cookie", cookies)
    .send({
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      city: "Lyon",
      isPublic: true,
      ...overrides,
    });

  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
  };
}

/** A user with a profile already, the state every other route assumes. */
async function seedProfile(
  overrides: Record<string, unknown> = {},
): Promise<Seeded> {
  const seeded = await seedUser();
  const created = await createProfileOverHttp(seeded.cookies, overrides);
  expect(created.status).toBe(201);

  return { ...seeded, profileId: created.body.id as string };
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

describe("creating a profile", () => {
  it("answers the profile it wrote, with its own id and dates", async () => {
    const seeded = await seedUser();

    const { status, body } = await createProfileOverHttp(seeded.cookies, {
      rppsNumber: "10101010101",
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      userId: seeded.userId,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      rppsNumber: "10101010101",
      city: "Lyon",
      isPublic: true,
      verified: false,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
  });

  it("normalises an RPPS number written with spaces and dashes", async () => {
    const seeded = await seedUser();

    const { body } = await createProfileOverHttp(seeded.cookies, {
      rppsNumber: "101 010-101.01",
    });

    // The regex the DTO checks is the number the column holds: a row keeping the
    // punctuation would fail every later uniqueness check on the same value.
    expect(body.rppsNumber).toBe("10101010101");
  });

  it("refuses a second profile for the same user", async () => {
    const seeded = await seedProfile();

    const { status, body } = await createProfileOverHttp(seeded.cookies);

    expect(status).toBe(409);
    expect(String(body.message)).toContain("already exists");
  });

  it("refuses an RPPS number already taken by somebody else", async () => {
    await seedProfile({ rppsNumber: "10101010101" });
    const second = await seedUser();

    const { status } = await createProfileOverHttp(second.cookies, {
      rppsNumber: "10101010101",
    });

    expect(status).toBe(409);
  });

  it("refuses a latitude without its longitude", async () => {
    const seeded = await seedUser();

    // The pair rule is enforced by the DTO, so it answers before any row is
    // read: a half-placed profile would be unplaceable on the map forever.
    const { status } = await createProfileOverHttp(seeded.cookies, {
      latitude: 45.7,
    });

    expect(status).toBe(400);
  });

  it("refuses an unknown field rather than storing it", async () => {
    const seeded = await seedUser();

    const { status } = await createProfileOverHttp(seeded.cookies, {
      isAdmin: true,
    });

    expect(status).toBe(400);
  });
});

describe("reading profiles", () => {
  it("answers the caller's own profile through /me, and 404s before it exists", async () => {
    const seeded = await seedProfile();

    const found = await request(fx.baseUrl)
      .get("/profile/me")
      .set("Cookie", seeded.cookies);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      id: seeded.profileId,
      userId: seeded.userId,
      profileType: "REPLACEMENT",
    });

    const without = await seedUser();
    const missing = await request(fx.baseUrl)
      .get("/profile/me")
      .set("Cookie", without.cookies);
    expect(missing.status).toBe(404);
  });

  it("publishes a public profile without its rppsNumber and its owner", async () => {
    const seeded = await seedProfile({
      rppsNumber: "10101010101",
      isPublic: true,
    });

    const response = await request(fx.baseUrl).get(
      `/profile/${seeded.profileId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: seeded.profileId,
      specialty: "GENERALIST",
    });
    // The directory is anonymous, so the two fields that identify a person to a
    // third party are withheld by the serializer, not by the reader.
    expect(response.body).not.toHaveProperty("rppsNumber");
    expect(response.body).not.toHaveProperty("userId");
  });

  it("404s a private profile to anybody but its owner", async () => {
    const seeded = await seedProfile({ isPublic: false });
    const stranger = await seedUser();

    const toStranger = await request(fx.baseUrl)
      .get(`/profile/${seeded.profileId}`)
      .set("Cookie", stranger.cookies);
    expect(toStranger.status).toBe(404);

    // The owner reads their own, private or not — the same route, with a
    // session, is the difference between the two answers.
    const toOwner = await request(fx.baseUrl)
      .get(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies);
    expect(toOwner.status).toBe(200);
  });

  it("lists public profiles and filters them, and 404s an unknown id", async () => {
    await seedProfile({ city: "Lyon", specialty: "GENERALIST" });
    await seedProfile({ city: "Brest", specialty: "DENTIST", isPublic: true });
    await seedProfile({ city: "Nice", isPublic: false });

    const all = await request(fx.baseUrl).get("/profile");
    expect(all.status).toBe(200);
    // The private profile is not in the directory at all.
    expect(all.body.data.map((row: { id: string }) => row.id)).toHaveLength(2);

    const inBrest = await request(fx.baseUrl).get("/profile").query({
      city: "Brest",
    });
    expect(inBrest.body.data).toHaveLength(1);
    expect(inBrest.body.data[0].specialty).toBe("DENTIST");
    expect(inBrest.body.meta.total).toBe(1);

    const dentists = await request(fx.baseUrl)
      .get("/profile")
      .query({ specialty: "DENTIST" });
    expect(dentists.body.data).toHaveLength(1);

    const unknown = await request(fx.baseUrl).get("/profile/does-not-exist");
    expect(unknown.status).toBe(404);
  });
});

describe("editing a profile", () => {
  it("writes the change and answers the profile that was written", async () => {
    const seeded = await seedProfile();

    const response = await request(fx.baseUrl)
      .patch(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies)
      .send({ city: "Grenoble", isPublic: false });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: seeded.profileId,
      city: "Grenoble",
      isPublic: false,
    });

    const stored = await fx.prisma.profile.findUniqueOrThrow({
      where: { id: seeded.profileId },
    });
    expect(stored.city).toBe("Grenoble");
  });

  it("refuses someone else's profile", async () => {
    const seeded = await seedProfile();
    const stranger = await seedUser();

    const response = await request(fx.baseUrl)
      .patch(`/profile/${seeded.profileId}`)
      .set("Cookie", stranger.cookies)
      .send({ city: "Elsewhere" });

    // The profile is public, so the stranger was allowed to read it: knowing it
    // exists, the answer for writing to it is 403.
    expect(response.status).toBe(403);
    const stored = await fx.prisma.profile.findUniqueOrThrow({
      where: { id: seeded.profileId },
    });
    expect(stored.city).toBe("Lyon");
  });

  it("404s an update of somebody else's private profile, which they cannot read", async () => {
    const seeded = await seedProfile({ isPublic: false });
    const stranger = await seedUser();

    const response = await request(fx.baseUrl)
      .patch(`/profile/${seeded.profileId}`)
      .set("Cookie", stranger.cookies)
      .send({ city: "Elsewhere" });

    // A profile that is not public reads as absent, so writing to it answers the
    // same way rather than confirming what the read hid.
    expect(response.status).toBe(404);
  });

  it("refuses an RPPS number another profile already holds", async () => {
    await seedProfile({ rppsNumber: "10101010101" });
    const other = await seedProfile();

    const { status } = await request(fx.baseUrl)
      .patch(`/profile/${other.profileId}`)
      .set("Cookie", other.cookies)
      .send({ rppsNumber: "10101010101" });

    expect(status).toBe(409);
  });

  it("refuses to move the practice without both coordinates", async () => {
    const seeded = await seedProfile();

    const { status } = await request(fx.baseUrl)
      .patch(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies)
      .send({ latitude: 45.7 });

    expect(status).toBe(400);
  });
});

describe("deleting a profile", () => {
  it("answers the profile it removed, then 404s on a second read", async () => {
    const seeded = await seedProfile();

    const response = await request(fx.baseUrl)
      .delete(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: seeded.profileId });
    expect(
      await fx.prisma.profile.count({ where: { id: seeded.profileId } }),
    ).toBe(0);

    const again = await request(fx.baseUrl)
      .delete(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies);
    expect(again.status).toBe(404);
  });

  it("refuses someone else's profile", async () => {
    const seeded = await seedProfile();
    const stranger = await seedUser();

    const response = await request(fx.baseUrl)
      .delete(`/profile/${seeded.profileId}`)
      .set("Cookie", stranger.cookies);

    expect(response.status).toBe(403);
    expect(
      await fx.prisma.profile.count({ where: { id: seeded.profileId } }),
    ).toBe(1);
  });

  it("refuses a deletion that would take another candidate's application with it", async () => {
    // The seeded profile is the one asking: it owns a practice, the practice
    // carries a posting, and a *different* candidate applied to that posting.
    const seeded = await seedProfile();
    const now = new Date();
    const candidate = await createVerifiedUser(
      fx.prisma,
      "candidate",
      "candidate@profile.test",
      PASSWORD,
    );
    const candidateProfile = await fx.prisma.profile.create({
      data: {
        id: "profile-candidate",
        userId: candidate.id,
        specialty: "GENERALIST",
        profileType: "REPLACEMENT",
        createdAt: now,
        updatedAt: now,
      },
    });
    const practice = await fx.prisma.practice.create({
      data: {
        id: "practice-owner",
        ownerId: seeded.profileId,
        name: "Cabinet",
        address: "1 rue",
        city: "Lyon",
        createdAt: now,
      },
    });
    const listing = await fx.prisma.replacementListing.create({
      data: {
        id: "listing-owner",
        practiceId: practice.id,
        createdById: seeded.profileId,
        title: "Remplacement",
        startDate: new Date("2026-11-02"),
        endDate: new Date("2026-11-16"),
        specialty: "GENERALIST",
        status: "OPEN",
        createdAt: now,
        updatedAt: now,
      },
    });
    await fx.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: candidateProfile.id,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      },
    });

    const response = await request(fx.baseUrl)
      .delete(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies);

    // The chain Profile -> Practice -> Listing -> Application would erase the
    // candidate's message and the practice's decision with it, and that data is
    // not the owner's to destroy.
    expect(response.status).toBe(409);
    expect(
      await fx.prisma.profile.count({ where: { id: seeded.profileId } }),
    ).toBe(1);
  });

  it("deletes a profile whose own application goes with it", async () => {
    const seeded = await seedProfile();
    const now = new Date();
    const owner = await createVerifiedUser(
      fx.prisma,
      "owner-2",
      "owner2@profile.test",
      PASSWORD,
    );
    const ownerProfile = await fx.prisma.profile.create({
      data: {
        id: "profile-owner-2",
        userId: owner.id,
        specialty: "GENERALIST",
        profileType: "INSTALLED",
        createdAt: now,
        updatedAt: now,
      },
    });
    const practice = await fx.prisma.practice.create({
      data: {
        id: "practice-owner-2",
        ownerId: ownerProfile.id,
        name: "Cabinet",
        address: "1 rue",
        city: "Lyon",
        createdAt: now,
      },
    });
    const listing = await fx.prisma.replacementListing.create({
      data: {
        id: "listing-owner-2",
        practiceId: practice.id,
        createdById: ownerProfile.id,
        title: "Remplacement",
        startDate: new Date("2026-11-02"),
        endDate: new Date("2026-11-16"),
        specialty: "GENERALIST",
        status: "OPEN",
        createdAt: now,
        updatedAt: now,
      },
    });
    await fx.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: seeded.profileId,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      },
    });

    const response = await request(fx.baseUrl)
      .delete(`/profile/${seeded.profileId}`)
      .set("Cookie", seeded.cookies);

    // The other half of the rule above: a candidate's own applications are
    // theirs to take with them, and the posting is left standing without them.
    expect(response.status).toBe(200);
    expect(await fx.prisma.application.count()).toBe(0);
    expect(
      await fx.prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(1);
  });
});
