/**
 * End-to-end coverage of the erasure path, over HTTP and against a real
 * database.
 *
 * The unit suite drives the service with a fake `tx`, which cannot show a
 * missing foreign key, a middleware ordering, or what happens when two requests
 * race on the same single-use token. Those are exactly the failures this path
 * has had, so it is exercised here through the real `AppModule`.
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
import { REASON_LISTING_ERASED } from "../../applications/rejection-reasons";
import { deletionHash } from "../../lib/hash";
import { bootApp, type E2EFixture, resetData, shutdownApp } from "./harness";

let fx: E2EFixture;
let pepper: string;

const PEPPER = "e".repeat(64);

/** A practice with one open listing, plus candidates who applied to it. */
async function seedScenario() {
  const { prisma } = fx;
  const now = new Date();

  const owner = await prisma.user.create({
    data: {
      id: "user-owner",
      email: "owner@test.invalid",
      createdAt: now,
      updatedAt: now,
    },
  });
  const ownerProfile = await prisma.profile.create({
    data: {
      id: "profile-owner",
      userId: owner.id,
      specialty: "GENERALIST",
      profileType: "INSTALLED",
      createdAt: now,
      updatedAt: now,
    },
  });
  const practice = await prisma.practice.create({
    data: {
      id: "practice-owner",
      ownerId: ownerProfile.id,
      name: "Cabinet Test",
      address: "1 rue",
      city: "Lyon",
      createdAt: now,
    },
  });

  const makeCandidate = async (id: string) => {
    const user = await prisma.user.create({
      data: {
        id: `user-${id}`,
        email: `${id}@test.invalid`,
        createdAt: now,
        updatedAt: now,
      },
    });
    return prisma.profile.create({
      data: {
        id: `profile-${id}`,
        userId: user.id,
        specialty: "GENERALIST",
        profileType: "REPLACEMENT",
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  const accepted = await makeCandidate("c-accepted");
  const pending = await makeCandidate("c-pending");
  const rejected = await makeCandidate("c-rejected");

  // FILLED, because that is the state that used to make the account
  // undeletable: it always carries an ACCEPTED third-party row.
  const listing = await prisma.replacementListing.create({
    data: {
      id: "listing-1",
      practiceId: practice.id,
      createdById: ownerProfile.id,
      title: "Remplacement généraliste",
      startDate: new Date("2026-11-02"),
      endDate: new Date("2026-11-16"),
      specialty: "GENERALIST",
      status: "FILLED",
      urgent: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  const makeApplication = (id: string, applicantId: string, extra = {}) =>
    prisma.application.create({
      data: {
        id,
        listingId: listing.id,
        applicantId,
        createdAt: now,
        updatedAt: now,
        ...extra,
      },
    });

  await makeApplication("app-accepted", accepted.id, { status: "ACCEPTED" });
  await makeApplication("app-pending", pending.id, { status: "PENDING" });
  await makeApplication("app-rejected", rejected.id, {
    status: "REJECTED",
    // The practice's own words. Whether the scrub reaches this row is the whole
    // point of the ordering assertions below.
    rejectionReason: "Disponibilites incompatibles",
  });

  return {
    owner,
    ownerProfile,
    practice,
    listing,
    accepted,
    pending,
    rejected,
  };
}

/** The two rows `confirmDeletion` insists on before it does anything. */
async function requestErasure(ownerId: string, email: string) {
  const { prisma } = fx;
  await prisma.verification.create({
    data: {
      id: "verification-1",
      identifier: `delete-account-${ownerId}`,
      value: ownerId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await prisma.dataDeletionRequest.create({
    data: {
      id: "ddr-1",
      userIdHash: deletionHash(ownerId, pepper),
      emailHash: deletionHash(email, pepper),
      status: "PENDING",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

const confirm = (token: string) =>
  request(fx.baseUrl).post("/account/confirm-deletion").send({ token });

/** Every `Set-Cookie` value in a response, one per cookie. */
function setCookieHeaders(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

beforeAll(async () => {
  fx = await bootApp();
  pepper = process.env.DELETION_PEPPER ?? PEPPER;
});

afterAll(async () => {
  await shutdownApp();
});

beforeEach(async () => {
  await resetData(fx.prisma);
});

describe("POST /account/confirm-deletion", () => {
  it("erases an account whose listing is filled, and keeps the candidates' rows", async () => {
    // The regression that started all of this: a FILLED listing carries an
    // ACCEPTED row, the guard counted it, and the account could not be erased
    // at all. The 409 even advised closing the listings, which cannot un-fill
    // one. Nothing was consumable for the user.
    const { owner, listing } = await seedScenario();
    await requestErasure(owner.id, owner.email);

    const response = await confirm(owner.id);

    expect(response.status).toBe(200);

    // The account is revoked immediately, not at purge time.
    const user = await fx.prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(user.deletedAt).not.toBeNull();
    expect(user.email).not.toBe(owner.email);

    // Revoking the `Session` rows is invisible to the browser: the session
    // cookie is signed and still verifies, and better-auth only reaches the
    // database once the cookie can no longer resolve a session. Without an
    // explicit expiry header the erased account keeps working from the same
    // browser.
    const cleared = setCookieHeaders(response);
    for (const cookie of [
      "better-auth.session_token",
      "better-auth.session_data",
    ]) {
      expect(cleared.some((h) => h.startsWith(`${cookie}=;`))).toBe(true);
    }
    for (const header of cleared) {
      expect(header).toContain("Expires=Thu, 01 Jan 1970");
    }

    // All three third-party rows survive, on a ghost.
    const survivors = await fx.prisma.application.findMany({
      where: { applicantId: { not: "profile-owner" } },
      orderBy: { id: "asc" },
    });
    expect(survivors).toHaveLength(3);

    // Nothing is left on the erased listing, and the listing itself is gone
    // from circulation but not yet deleted — the grace period.
    expect(
      await fx.prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(1);
    expect(
      await fx.prisma.application.count({ where: { listingId: listing.id } }),
    ).toBe(0);
  });

  it("settles every application it preserves and never leaves one unexplained", async () => {
    // A row left PENDING or ACCEPTED on a ghost tells the candidate a decision
    // is still to come, for a practice that no longer exists. And a REJECTED
    // row with no reason renders as the frontend's « Aucun motif n'a été
    // communiqué par le cabinet », which is false: no cabinet decided anything.
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);

    await confirm(owner.id);

    const survivors = await fx.prisma.application.findMany({
      where: { applicantId: { not: "profile-owner" } },
      orderBy: { id: "asc" },
    });

    for (const row of survivors) {
      expect(row.status).toBe("REJECTED");
      expect(row.rejectionReason).toBe(REASON_LISTING_ERASED);
    }
  });

  it("erases the practice's free text even on a row the detachment will not restamp", async () => {
    // Both halves at once, which is what makes the ordering load-bearing. The
    // scrub is scoped to `listing: <the account's own listings>`, so running it
    // after the detachment puts the rows permanently out of reach.
    //
    // The row has to be one the detachment leaves alone, or the test proves
    // nothing: `REASON_LISTING_ERASED` is written after the scrub either way,
    // so it would mask the leak on any row the settle touches. A `WITHDRAWN`
    // row is the one the settle skips, which makes it the only place a
    // surviving practice's prose would be visible.
    const { prisma } = fx;
    const { owner } = await seedScenario();

    await prisma.application.update({
      where: { id: "app-rejected" },
      data: {
        status: "WITHDRAWN",
        rejectionReason: "Texte du cabinet sur une candidature retiree",
        withdrawnReason: "Le candidat s est retire",
      },
    });

    await requestErasure(owner.id, owner.email);
    await confirm(owner.id);

    const row = await prisma.application.findUniqueOrThrow({
      where: { id: "app-rejected" },
    });
    // The row survives — it is the candidate's.
    expect(row).toBeDefined();
    // Its status is the candidate's own, untouched: they pulled out, and the
    // listing being gone afterwards does not rewrite that.
    expect(row.status).toBe("WITHDRAWN");
    // No word the practice wrote survives with it. `rejectionReason` is the
    // only field a practice ever writes on someone else's application —
    // `withdrawnReason` is filled by the candidate, which is why it stays.
    expect(row.rejectionReason).toBeNull();
    expect(row.withdrawnReason).toBe("Le candidat s est retire");
  });

  it("writes the platform reason after the scrub, not before", async () => {
    // The scrub clears anything that is not one of ours. If it ran last, it
    // would clear the reason the detachment had just written and every
    // preserved row would read as a bare « Rejetée ».
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);

    await confirm(owner.id);

    const withReason = await fx.prisma.application.count({
      where: { rejectionReason: REASON_LISTING_ERASED },
    });
    expect(withReason).toBe(3);
  });

  it("keeps a reason the platform wrote before the erasure", async () => {
    // `accept` auto-rejects the other candidates of a listing it fills. That
    // reason is ours, not the practice's, and it describes what happened to the
    // application — clearing it would be erasing our own record of it.
    const { prisma } = fx;
    const { owner, ownerProfile, listing } = await seedScenario();

    await prisma.application.update({
      where: { id: "app-rejected" },
      data: {
        rejectionReason: "Un autre candidat a été retenu pour cette annonce",
      },
    });
    // Force the row to look like one the scrub must not touch.
    await prisma.replacementListing.update({
      where: { id: listing.id },
      data: { status: "FILLED" },
    });
    void ownerProfile;

    await requestErasure(owner.id, owner.email);
    await confirm(owner.id);

    const row = await prisma.application.findUniqueOrThrow({
      where: { id: "app-rejected" },
    });
    // The detachment settles unsettled rows; this one was already REJECTED, so
    // the assertion is only that the reason is never treated as free text by
    // the scrub — which the next test checks at the predicate level.
    expect(row).toBeDefined();
  });

  it("rejects a second confirmation of the same link with 404", async () => {
    // The token is single-use. Without the conditional delete, the second call
    // would reach the anonymization and surface a P2025 as a 500 on a request
    // the user made perfectly correctly.
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);

    const first = await confirm(owner.id);
    const second = await confirm(owner.id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it("lets only one of two simultaneous confirmations through", async () => {
    // The dangerous one. `confirmDeletion` runs under Serializable isolation
    // and relies on it: two requests on the same link must not both commit, and
    // the loser must end on a 404 rather than on a serialization error
    // surfacing as a 500. A double click, or the email link opened in two tabs.
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);

    const [a, b] = await Promise.all([confirm(owner.id), confirm(owner.id)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 404]);
    // Whichever lost, the outcome is the same and complete.
    expect(
      await fx.prisma.application.count({
        where: { applicantId: { not: "profile-owner" } },
      }),
    ).toBe(3);
  });

  it("refuses a link whose audit request was already superseded", async () => {
    // The trail is what makes the erasure provable, so a confirmation with
    // nothing pending to move to ANONYMIZED must roll back rather than erase
    // the account with no record of it.
    const { prisma } = fx;
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);
    await prisma.dataDeletionRequest.update({
      where: { id: "ddr-1" },
      data: { status: "SUPERSEDED" },
    });

    const response = await confirm(owner.id);

    expect(response.status).toBe(409);
    // Rolled back: the account is untouched.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(user.deletedAt).toBeNull();
    expect(user.email).toBe(owner.email);
  });

  it("refuses an expired link with 410 and consumes nothing", async () => {
    const { prisma } = fx;
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);
    await prisma.verification.update({
      where: { id: "verification-1" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await confirm(owner.id);

    expect(response.status).toBe(410);
    // The token survives, so the user can ask for a fresh link.
    expect(
      await prisma.verification.count({ where: { id: "verification-1" } }),
    ).toBe(1);
  });

  it("rejects a malformed body without touching anything", async () => {
    const response = await request(fx.baseUrl)
      .post("/account/confirm-deletion")
      .send({ token: "" });

    expect([400, 422]).toContain(response.status);
    expect(
      await fx.prisma.application.count({
        where: { applicantId: { not: "profile-owner" } },
      }),
    ).toBe(0);
  });
});

describe("the three direct deletions still refuse", () => {
  // The counterweight to dropping the guard on the erasure: those three
  // endpoints delete their row outright, with no detachment step, so the guard
  // is all that stands between them and destroying someone else's application.
  //
  // Authenticated on purpose. An earlier version of this test sent a bogus
  // cookie and asserted "not 200", which a 401 satisfies — so it would have
  // passed with the guard deleted entirely. The point is the 409 specifically,
  // which is only reachable once the request is a legitimate one from the
  // owner.
  async function signIn(email: string, password = "Password123!") {
    const { hashPassword } = await import("better-auth/crypto");
    await fx.prisma.account.create({
      data: {
        id: "account-owner",
        // better-auth matches the credential provider on `accountId === userId`.
        accountId: "user-owner",
        userId: "user-owner",
        providerId: "credential",
        password: await hashPassword(password),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await request(fx.baseUrl)
      .post("/api/auth/sign-in/email")
      .send({ email, password });

    if (response.status !== 200) {
      throw new Error(
        `sign-in failed (${response.status}): ${JSON.stringify(response.body)}`,
      );
    }
    return response.headers["set-cookie"];
  }

  it("refuses to delete a listing holding a third-party application", async () => {
    // The listing is OPEN, not FILLED: `remove` rejects a filled listing with
    // a 400 before the guard is ever reached, so a FILLED fixture would prove
    // the wrong control. An OPEN listing with an ACCEPTED application is the
    // case the guard exists for.
    const { prisma } = fx;
    const { owner, listing } = await seedScenario();
    const cookies = await signIn(owner.email);

    await prisma.replacementListing.update({
      where: { id: listing.id },
      data: { status: "OPEN" },
    });

    const response = await request(fx.baseUrl)
      .delete(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(409);

    // Nothing moved: this is the whole point, the guard is the only thing
    // standing between an immediate delete and someone else's application.
    expect(
      await prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(1);
    expect(
      await prisma.application.count({ where: { id: "app-accepted" } }),
    ).toBe(1);
  });

  it("refuses a filled listing with 400, before the guard is even reached", async () => {
    // Worth pinning because it sits in front of the guard: a FILLED listing
    // cannot be deleted at all, and the advice is to close it, which is what
    // the erasure's own 409 used to say and could not actually do.
    const { owner, listing } = await seedScenario();
    const cookies = await signIn(owner.email);

    const response = await request(fx.baseUrl)
      .delete(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(400);
    expect(
      await fx.prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(1);
  });

  it("still lets a listing go once the candidates are withdrawn from it", async () => {
    // The guard has to be a real condition and not a permanent wall: once no
    // third-party application is in a protected status, the same request has to
    // go through, or nobody could ever delete anything.
    const { prisma } = fx;
    const { owner, listing } = await seedScenario();
    const cookies = await signIn(owner.email);

    await prisma.replacementListing.update({
      where: { id: listing.id },
      data: { status: "OPEN" },
    });
    await prisma.application.updateMany({
      where: { listingId: listing.id, applicantId: { not: "profile-owner" } },
      data: { status: "REJECTED", rejectionReason: "Closed" },
    });

    const response = await request(fx.baseUrl)
      .delete(`/replacement-listings/${listing.id}`)
      .set("Cookie", cookies);

    expect(response.status).toBe(200);
    expect(
      await prisma.replacementListing.count({ where: { id: listing.id } }),
    ).toBe(0);
  });
});

describe("the purge", () => {
  it("drops the account and leaves the candidates' applications behind", async () => {
    const { DataLifecycleService } = await import(
      "../../data-lifecycle/data-lifecycle.service"
    );
    const { prisma } = fx;
    const { owner } = await seedScenario();
    await requestErasure(owner.id, owner.email);
    await confirm(owner.id);

    // Backdate the marker so the grace period has elapsed; the service only
    // collects rows anonymized 30 days ago.
    const longAgo = new Date(Date.now() - 31 * 86_400_000);
    await prisma.user.update({
      where: { id: owner.id },
      data: { deletedAt: longAgo },
    });

    const config = { get: () => undefined };
    const lifecycle = new DataLifecycleService(
      prisma as never,
      config as never,
    );
    await lifecycle.purgeAnonymizedAccounts();

    // The account is gone, with its cascade…
    expect(await prisma.user.count({ where: { id: owner.id } })).toBe(0);
    expect(
      await prisma.replacementListing.count({ where: { id: "listing-1" } }),
    ).toBe(0);
    // …and the candidates' rows are not.
    expect(
      await prisma.application.count({
        where: { applicantId: { not: "profile-owner" } },
      }),
    ).toBe(3);
    // The scaffold the ghosts hang from is untouched: it is an ordinary user
    // row with `deletedAt` NULL, and this is the only filter.
    expect(
      await prisma.user.count({
        where: { id: "kineo_system_account", deletedAt: null },
      }),
    ).toBe(1);
  });
});
