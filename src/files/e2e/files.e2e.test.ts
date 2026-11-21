/**
 * The file service over HTTP: uploads, guarded streaming and the CV snapshot.
 *
 * The unit suites prove validators and access rules against fakes; this one
 * proves the whole path — Multer, Zod DTOs, the throttler, better-auth sessions,
 * `StreamableFile` and a real RustFS bucket — agrees with them.
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
  signInReader,
} from "../../common/e2e/harness";

const PASSWORD = "Password123!";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function pdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}

let fx: E2EFixture;

interface World {
  ownerCookies: string;
  candidateCookies: string;
  strangerCookies: string;
  ownerProfileId: string;
  candidateProfileId: string;
  practiceId: string;
  listingId: string;
}

async function seedWorld(): Promise<World> {
  const { prisma } = fx;
  const now = new Date();

  const owner = await createVerifiedUser(
    prisma,
    "user-owner",
    "owner@files.test",
    PASSWORD,
  );
  const ownerProfile = await prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: owner.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      isPublic: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  const practice = await prisma.practice.create({
    data: {
      id: "practice-owner",
      ownerId: ownerProfile.id,
      name: "Files Practice",
      address: "1 rue",
      city: "Lyon",
      isPublic: true,
      createdAt: now,
    },
  });
  const listing = await prisma.replacementListing.create({
    data: {
      id: "listing-1",
      practiceId: practice.id,
      createdById: ownerProfile.id,
      title: "Cover",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    },
  });

  const candidate = await createVerifiedUser(
    prisma,
    "user-candidate",
    "candidate@files.test",
    PASSWORD,
  );
  const candidateProfile = await prisma.profile.create({
    data: {
      id: "profile-candidate",
      userId: candidate.id,
      specialty: "GENERALIST",
      profileType: "REPLACEMENT",
      isPublic: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  return {
    ownerCookies: await signIn(fx.baseUrl, owner.email, PASSWORD),
    candidateCookies: await signIn(fx.baseUrl, candidate.email, PASSWORD),
    strangerCookies: await signInReader(fx),
    ownerProfileId: ownerProfile.id,
    candidateProfileId: candidateProfile.id,
    practiceId: practice.id,
    listingId: listing.id,
  };
}

function uploadAvatar(cookies: string, buffer = PNG, name = "avatar.png") {
  return request(fx.baseUrl)
    .post("/files/avatar")
    .set("Cookie", cookies)
    .attach("file", buffer, name);
}

function uploadCv(cookies: string, buffer: Buffer, name = "cv.pdf") {
  return request(fx.baseUrl)
    .post("/files/cv")
    .set("Cookie", cookies)
    .attach("file", buffer, name);
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

describe("authentication", () => {
  it("refuses an upload without a session, before Multer runs", async () => {
    const response = await request(fx.baseUrl)
      .post("/files/avatar")
      .attach("file", PNG, "avatar.png");

    expect(response.status).toBe(401);
    expect(
      await fx.prisma.storedFile.count({ where: { kind: "AVATAR" } }),
    ).toBe(0);
  });

  it("refuses the application CV route without a session", async () => {
    const response = await request(fx.baseUrl).post("/applications/any-id/cv");
    expect(response.status).toBe(401);
  });
});

describe("anonymous reads via @OptionalAuth", () => {
  it("streams a public avatar and a public listing's photos", async () => {
    const world = await seedWorld();
    const avatar = await uploadAvatar(world.ownerCookies);
    const images = await request(fx.baseUrl)
      .post(`/files/listings/${world.listingId}/images`)
      .set("Cookie", world.ownerCookies)
      .attach("images", PNG, "one.png");
    expect(images.status).toBe(201);

    const avatarRead = await request(fx.baseUrl).get(avatar.body.url);
    expect(avatarRead.status).toBe(200);
    expect(avatarRead.body).toEqual(PNG);

    const photosRead = await request(fx.baseUrl).get(
      `/files/listings/${world.listingId}/images`,
    );
    expect(photosRead.status).toBe(200);
    expect(photosRead.body).toHaveLength(1);
  });

  it("never serves a CV without a session", async () => {
    const world = await seedWorld();
    const cv = await uploadCv(world.candidateCookies, pdf("anonymous-read"));

    const response = await request(fx.baseUrl).get(cv.body.url);
    expect(response.status).toBe(404);
  });
});

describe("avatar uploads", () => {
  it("stores the photo and streams it back inline", async () => {
    const world = await seedWorld();
    const uploaded = await uploadAvatar(world.ownerCookies);

    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({
      kind: "AVATAR",
      mimeType: "image/png",
      originalName: "avatar.png",
    });
    expect(uploaded.body.url).toBe(`/files/${uploaded.body.id}`);

    const read = await request(fx.baseUrl)
      .get(uploaded.body.url)
      .set("Cookie", world.strangerCookies);

    expect(read.status).toBe(200);
    expect(read.headers["content-type"]).toContain("image/png");
    expect(read.headers["content-disposition"]).toContain("inline");
    expect(read.body).toEqual(PNG);
  });

  it("lists only the caller's own files", async () => {
    const world = await seedWorld();
    await uploadAvatar(world.ownerCookies);

    const mine = await request(fx.baseUrl)
      .get("/files/mine")
      .set("Cookie", world.ownerCookies);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ kind: "AVATAR" });

    const other = await request(fx.baseUrl)
      .get("/files/mine")
      .set("Cookie", world.candidateCookies);
    expect(other.body).toEqual([]);
  });

  it("replaces the old avatar and drops the old object", async () => {
    const world = await seedWorld();
    const first = await uploadAvatar(world.ownerCookies);
    const second = await uploadAvatar(world.ownerCookies);

    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(
      await fx.prisma.storedFile.count({ where: { kind: "AVATAR" } }),
    ).toBe(1);
    expect(
      (
        await request(fx.baseUrl)
          .get(first.body.url)
          .set("Cookie", world.ownerCookies)
      ).status,
    ).toBe(404);
  });
});

describe("CV validation and privacy", () => {
  it("refuses a PNG sent as a CV, even with a PDF MIME header", async () => {
    const world = await seedWorld();
    const response = await uploadCv(world.candidateCookies, PNG, "cv.pdf");
    expect(response.status).toBe(422);
  });

  it("accepts a PDF, private to its owner", async () => {
    const world = await seedWorld();
    const content = pdf("profile-cv-v1");
    const uploaded = await uploadCv(world.candidateCookies, content);

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.mimeType).toBe("application/pdf");

    const ownerRead = await request(fx.baseUrl)
      .get(uploaded.body.url)
      .set("Cookie", world.candidateCookies);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.headers["content-disposition"]).toContain("attachment");
    expect(ownerRead.body).toEqual(content);

    const strangerRead = await request(fx.baseUrl)
      .get(uploaded.body.url)
      .set("Cookie", world.strangerCookies);
    expect(strangerRead.status).toBe(404);
  });
});

describe("listing photos", () => {
  it("lets the owner upload several photos and follows listing visibility", async () => {
    const world = await seedWorld();
    const uploaded = await request(fx.baseUrl)
      .post(`/files/listings/${world.listingId}/images`)
      .set("Cookie", world.ownerCookies)
      .attach("images", PNG, "one.png")
      .attach("images", PNG, "two.png");

    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toHaveLength(2);
    expect(
      uploaded.body.map((file: { position: number }) => file.position),
    ).toEqual([0, 1]);

    const listed = await request(fx.baseUrl)
      .get(`/files/listings/${world.listingId}/images`)
      .set("Cookie", world.strangerCookies);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(2);

    await fx.prisma.replacementListing.update({
      where: { id: world.listingId },
      data: { status: "CLOSED" },
    });

    expect(
      (
        await request(fx.baseUrl)
          .get(`/files/listings/${world.listingId}/images`)
          .set("Cookie", world.strangerCookies)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(fx.baseUrl)
          .get(`/files/listings/${world.listingId}/images`)
          .set("Cookie", world.ownerCookies)
      ).status,
    ).toBe(200);
  });

  it("refuses an upload from someone who does not own the listing", async () => {
    const world = await seedWorld();
    const response = await request(fx.baseUrl)
      .post(`/files/listings/${world.listingId}/images`)
      .set("Cookie", world.candidateCookies)
      .attach("images", PNG, "one.png");

    expect(response.status).toBe(403);
  });
});

describe("application CV snapshots", () => {
  it("copies the profile CV for the practice owner and keeps it immutable", async () => {
    const world = await seedWorld();
    const v1 = pdf("application-cv-v1");
    const profileCv = await uploadCv(world.candidateCookies, v1);
    expect(profileCv.status).toBe(201);

    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listingId,
        applicantId: world.candidateProfileId,
        message: "Je suis disponible",
      },
    });

    const attached = await request(fx.baseUrl)
      .post(`/applications/${application.id}/cv`)
      .set("Cookie", world.candidateCookies);
    expect(attached.status).toBe(201);

    const cvUrl = `/applications/${application.id}/cv`;

    const practiceRead = await request(fx.baseUrl)
      .get(cvUrl)
      .set("Cookie", world.ownerCookies);
    expect(practiceRead.status).toBe(200);
    expect(practiceRead.body).toEqual(v1);

    const applicantRead = await request(fx.baseUrl)
      .get(cvUrl)
      .set("Cookie", world.candidateCookies);
    expect(applicantRead.status).toBe(200);

    const strangerRead = await request(fx.baseUrl)
      .get(cvUrl)
      .set("Cookie", world.strangerCookies);
    expect(strangerRead.status).toBe(404);

    // Editing the reusable CV leaves the snapshot the practice received alone.
    const v2 = await uploadCv(world.candidateCookies, pdf("application-cv-v2"));
    expect(v2.status).toBe(201);
    const afterEdit = await request(fx.baseUrl)
      .get(cvUrl)
      .set("Cookie", world.ownerCookies);
    expect(afterEdit.body).toEqual(v1);
  });

  it("refuses to attach a CV to somebody else's application", async () => {
    const world = await seedWorld();
    const application = await fx.prisma.application.create({
      data: {
        listingId: world.listingId,
        applicantId: world.candidateProfileId,
      },
    });

    // A signed-in member with a profile but no claim on that application.
    const response = await request(fx.baseUrl)
      .post(`/applications/${application.id}/cv`)
      .set("Cookie", world.ownerCookies);
    expect(response.status).toBe(403);
  });

  it("lets the uploader delete a file", async () => {
    const world = await seedWorld();
    const uploaded = await uploadAvatar(world.ownerCookies);

    const deleted = await request(fx.baseUrl)
      .delete(uploaded.body.url)
      .set("Cookie", world.ownerCookies);
    expect(deleted.status).toBe(200);

    const after = await request(fx.baseUrl)
      .get(uploaded.body.url)
      .set("Cookie", world.ownerCookies);
    expect(after.status).toBe(404);
  });
});
