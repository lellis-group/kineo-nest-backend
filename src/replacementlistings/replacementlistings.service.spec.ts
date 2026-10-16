import { describe, expect, it } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { PrismaService } from "../prisma.service";
import { PLACE_PREVIEW_LIMIT } from "./browse";
import {
  orderByFor,
  ReplacementlistingsService,
} from "./replacementlistings.service";

const profile = { id: "profile-1", userId: "user-1" };
const listing = {
  id: "listing-1",
  practiceId: "practice-1",
  createdById: profile.id,
  startDate: new Date("2026-09-10T08:00:00.000Z"),
  endDate: new Date("2026-09-12T08:00:00.000Z"),
  specialty: "GENERALIST",
  status: "DRAFT",
  urgent: false,
  description: null,
  maxApplications: null,
  createdAt: new Date("2026-08-20T08:00:00.000Z"),
  updatedAt: new Date("2026-08-20T08:00:00.000Z"),
};

const openListing = { ...listing, status: "OPEN" };

describe("ReplacementlistingsService", () => {
  it("persists maxApplications when creating a listing", async () => {
    let createData: unknown;
    const transactionClient = {
      practice: {
        findUnique: async () => ({ id: "practice-1", ownerId: profile.id }),
      },
      replacementListing: {
        count: async () => 0,
        create: async ({ data }: { data: unknown }) => {
          createData = data;
          return { ...listing, maxApplications: 3 };
        },
      },
    };
    const prisma = {
      profile: { findUnique: async () => profile },
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await service.create("user-1", {
      practiceId: "practice-1",
      title: "General practitioner",
      startDate: "2026-09-10T08:00:00.000Z",
      endDate: "2026-09-12T08:00:00.000Z",
      specialty: "GENERALIST",
      maxApplications: 3,
    });

    expect(createData).toMatchObject({ maxApplications: 3 });
  });

  it("rejects a partial date update that would invalidate a listing", async () => {
    // `update` runs in a transaction, so the fake has to offer one.
    const reads = {
      replacementListing: { findUnique: async () => listing },
      profile: { findUnique: async () => profile },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.update("listing-1", "user-1", {
        endDate: "2026-09-01T08:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("re-derives the status when maxApplications changes", async () => {
    // A `FULL` listing whose owner raises the cap used to stay `FULL` and refuse
    // every candidate it had room for. The capacity is an input to the
    // derivation, so writing it without re-deriving leaves the row asserting
    // something the code no longer believes — and no transition could undo it.
    const full = {
      ...openListing,
      status: "FULL",
      maxApplications: 2,
    };
    const writes: { status?: string } = {};
    let row = { ...full };

    const reads = {
      profile: { findUnique: async () => profile },
      application: { count: async () => 2 },
      replacementListing: {
        findUnique: async () => row,
        findUniqueOrThrow: async () => ({
          ...row,
          _count: { applications: 2 },
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          writes.status = args.data.status as string | undefined;
          // Prisma ignores `undefined` inside a data object, so the fake has to
          // as well — otherwise it blanks the dates the service left alone and the
          // failure looks like a date bug.
          const defined = Object.fromEntries(
            Object.entries(args.data).filter(
              ([, value]) => value !== undefined,
            ),
          );
          row = { ...row, ...defined };
          return { ...row, _count: { applications: 2 } };
        },
      },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const updated = await service.update("listing-1", "user-1", {
      maxApplications: 5,
    });

    // Two active applications against a cap of five is IN_DISCUSSION, and the
    // response has to carry the status that was written.
    expect(writes.status).toBe("IN_DISCUSSION");
    expect(updated.status).toBe("IN_DISCUSSION");
  });

  it("leaves the status alone when the capacity did not change", async () => {
    let recalculated = false;
    const reads = {
      profile: { findUnique: async () => profile },
      application: {
        count: async () => {
          recalculated = true;
          return 0;
        },
      },
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
        findUniqueOrThrow: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
        update: async () => ({ ...openListing, _count: { applications: 0 } }),
      },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (tx: typeof reads) => unknown) =>
        operation(reads),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await service.update("listing-1", "user-1", { title: "New title" });

    // A title does not move the derivation, so it is not run: one fewer count on
    // a path that runs on every edit.
    expect(recalculated).toBe(false);
  });

  it("allows anyone to view an OPEN listing", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1");
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("allows anonymous users to view an OPEN listing", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 0 },
        }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1", undefined);
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("blocks unauthenticated access to non-OPEN listings", async () => {
    const prisma = {
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(
      service.findOne("listing-1", undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows owner to view their own non-OPEN listing", async () => {
    const prisma = {
      profile: { findUnique: async () => profile },
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.findOne("listing-1", "user-1");
    expect(result).toBeDefined();
    expect(result.id).toBe("listing-1");
  });

  it("blocks non-owner from viewing non-OPEN listings", async () => {
    const otherProfile = { id: "profile-2", userId: "user-2" };
    const prisma = {
      profile: { findUnique: async () => otherProfile },
      replacementListing: {
        findUnique: async () => ({ ...listing, _count: { applications: 0 } }),
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(service.findOne("listing-1", "user-2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("closes a listing and rejects its candidates on the same client", async () => {
    // `close` used to read the listing on the service's own client and then
    // write, outside any transaction: a candidate who applied between the two
    // landed on a posting that had just left circulation.
    const tx = {
      replacementListing: {
        findUnique: async () => ({
          ...openListing,
          _count: { applications: 1 },
        }),
        update: async ({ data }: { data: { status: string } }) => ({
          ...openListing,
          status: data.status,
          _count: { applications: 0 },
        }),
      },
      profile: { findUnique: async () => profile },
      application: {
        updateMany: async () => ({ count: 1 }),
      },
    };
    const reads = {
      replacementListing: {
        findUnique: async () => {
          throw new Error("close must read inside its transaction");
        },
      },
    };
    const prisma = {
      ...reads,
      $transaction: async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    const result = await service.close("listing-1", "user-1");

    expect(result.status).toBe("CLOSED_NO_CANDIDATE");
  });

  it("returns 404 when listing does not exist", async () => {
    const prisma = {
      replacementListing: { findUnique: async () => null },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ReplacementlistingsService(prisma, config);

    await expect(service.findOne("nonexistent-id")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * The « next replacement » the home screen shows.
   *
   * It has to be answered by the server: a client can only find it by reading
   * every page of the member's postings and comparing dates, and what it found
   * was the soonest among the pages it walked — a wrong date on a home screen
   * rather than an obviously missing one. So the two things this could get wrong
   * are asserted here: the scope it ignores (the caller's filter, its page) and
   * the statuses it considers in play.
   */
  describe("findMine's next replacement", () => {
    type FindFirstArgs = {
      where: Record<string, unknown>;
      orderBy: unknown;
      select: Record<string, boolean>;
    };

    function serviceRecordingFirst(
      findFirst: (args: FindFirstArgs) => unknown,
    ) {
      const calls: FindFirstArgs[] = [];
      const prisma = {
        profile: { findUnique: async () => ({ id: "profile-1" }) },
        replacementListing: {
          findMany: async () => [],
          count: async () => 0,
          groupBy: async () => [],
          findFirst: async (args: FindFirstArgs) => {
            calls.push(args);
            return findFirst(args);
          },
        },
        application: { count: async () => 0 },
      } as unknown as PrismaService;

      return {
        calls,
        service: new ReplacementlistingsService(prisma, {
          get: () => undefined,
        } as unknown as ConfigService),
      };
    }

    const page = { page: 1, limit: 10 };

    it("asks the database for the soonest period, not the newest posting", async () => {
      const { calls, service } = serviceRecordingFirst(() => ({
        id: "listing-1",
        title: "RemplacementDental",
        startDate: new Date("2026-11-01T08:00:00.000Z"),
        endDate: new Date("2026-11-04T08:00:00.000Z"),
      }));

      await service.findMine("user-1", page);

      expect(calls[0]?.orderBy).toEqual([{ startDate: "asc" }, { id: "asc" }]);
    });

    it("ignores the caller's status filter", async () => {
      const { calls, service } = serviceRecordingFirst(() => null);

      // « Your next replacement » does not change because the list happens to be
      // filtered on the bucket the next one is not in.
      await service.findMine("user-1", { ...page, status: "CANCELLED" });

      const where = calls[0]?.where as {
        createdById: string;
        status: { in: string[] };
        startDate: { gt: Date };
      };
      expect(where.createdById).toBe("profile-1");
      expect(where.status).toEqual({ in: ["OPEN", "IN_DISCUSSION", "FULL"] });
    });

    it("excludes a posting whose period has passed", async () => {
      const { calls, service } = serviceRecordingFirst(() => null);

      await service.findMine("user-1", page);

      const where = calls[0]?.where as { startDate: { gt: Date } };
      expect(where.startDate.gt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("answers null when nothing is coming", async () => {
      const { service } = serviceRecordingFirst(() => null);

      const result = await service.findMine("user-1", page);

      expect(result.meta.nextRecruitingListing).toBeNull();
    });

    it("sends the bounds as ISO instants, like the rest of the wire", async () => {
      const { service } = serviceRecordingFirst(() => ({
        id: "listing-1",
        title: "Remplacement",
        startDate: new Date("2026-11-01T08:00:00.000Z"),
        endDate: new Date("2026-11-04T08:00:00.000Z"),
      }));

      const result = await service.findMine("user-1", page);

      expect(result.meta.nextRecruitingListing).toEqual({
        id: "listing-1",
        title: "Remplacement",
        startDate: "2026-11-01T08:00:00.000Z",
        endDate: "2026-11-04T08:00:00.000Z",
      });
    });
  });

  describe("findPlaces", () => {
    const at = (id: string, latitude: number | null = 50.6) => ({
      id,
      name: `P ${id}`,
      city: "Lille",
      latitude,
      longitude: 3.05,
    });

    type Preview = {
      id: string;
      practiceId: string;
      title: string;
      startDate: Date;
      endDate: Date;
    };

    /**
     * A prisma that answers the three reads `findPlaces` makes. The previews and
     * the id list are told apart by what they select, because the two reads are
     * otherwise the same query.
     */
    function prismaFor(
      groups: Array<{ practiceId: string; _count: number }>,
      practices: Array<ReturnType<typeof at>>,
      previews: Preview[] = [],
      ids: string[] = [],
    ) {
      return {
        replacementListing: {
          groupBy: async () => groups,
          findMany: async (args: { select?: Record<string, boolean> }) =>
            args.select && "title" in args.select
              ? previews
              : ids.map((id) => ({ id })),
        },
        practice: { findMany: async () => practices },
      } as unknown as PrismaService;
    }

    const service = (prisma: unknown) =>
      new ReplacementlistingsService(
        prisma as PrismaService,
        {
          get: () => undefined,
        } as unknown as ConfigService,
      );

    const posting = (id: string, practiceId: string): Preview => ({
      id,
      practiceId,
      title: `cover ${id}`,
      startDate: new Date("2026-11-01T08:00:00.000Z"),
      endDate: new Date("2026-11-02T08:00:00.000Z"),
    });

    it("counts a ungeocoded practice as unlocated, not as a place", async () => {
      const result = await service(
        prismaFor(
          [
            { practiceId: "p1", _count: 3 },
            { practiceId: "p2", _count: 1 },
          ],
          [at("p1"), at("p2", null)],
        ),
      ).findPlaces({}, 200);

      expect(result.places.map((place) => place.practiceId)).toEqual(["p1"]);
      expect(result.unlocated).toBe(1);
    });

    /**
     * The population and the preview are different numbers, on purpose.
     *
     * The preview is capped so a popup does not need a scrollbar. Reading the
     * population from the preview would report "4" for a place holding nine,
     * which is exactly what the badge and the "+N others" line say.
     */
    it("reports the population in `count` while previewing only four", async () => {
      const nine = Array.from({ length: 9 }, (_, i) => posting(`l${i}`, "p1"));

      const result = await service(
        prismaFor(
          [{ practiceId: "p1", _count: 9 }],
          [at("p1")],
          nine,
          nine.map((l) => l.id),
        ),
      ).findPlaces({}, 200);

      const [place] = result.places;
      expect(place.count).toBe(9);
      expect(place.listings).toHaveLength(PLACE_PREVIEW_LIMIT);
    });

    it("truncates, and says so, past the ceiling", async () => {
      const groups = Array.from({ length: 8 }, (_, i) => ({
        practiceId: `b${i}`,
        _count: 1,
      }));
      const practices = groups.map((g) => at(g.practiceId));

      const result = await service(prismaFor(groups, practices)).findPlaces(
        {},
        3,
      );

      expect(result.places).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });

    it("does not truncate when the ceiling holds", async () => {
      const result = await service(
        prismaFor(
          [
            { practiceId: "p1", _count: 1 },
            { practiceId: "p2", _count: 1 },
          ],
          [at("p1"), at("p2")],
        ),
      ).findPlaces({}, 200);

      expect(result.truncated).toBe(false);
    });

    /**
     * `specialty` is honoured here and dropped in `/facets`, deliberately.
     *
     * The distribution panel shows what else is on offer, so it ignores the
     * specialty the reader just filtered on. The map has no such excuse: a pin
     * for a posting of another specialty is a pin the list does not show.
     */
    it("passes the filters through, unlike the facets aggregate", async () => {
      let askedWhere: unknown;
      const svc = service({
        replacementListing: {
          groupBy: async (args: { where: unknown }) => {
            askedWhere = args.where;
            return [];
          },
          findMany: async () => [],
        },
        practice: { findMany: async () => [] },
      });

      await svc.findPlaces({ specialty: "DENTIST" }, 200);

      expect(askedWhere).toMatchObject({ specialty: "DENTIST" });
    });

    /**
     * Free text reaches the map's read as an `OR` over the posting's own words.
     *
     * The map honours every filter the list does — a pin showing postings the
     * search excluded would be the lie the whole split exists to avoid. The `OR`
     * is the shape a term that can sit in the title *or* the description needs,
     * and it is omitted when there is no term, because an empty `OR` matches
     * nothing and would blank the map on an unfiltered view.
     */
    it("matches free text on title or description, and omits it when unset", async () => {
      let askedWhere: unknown;
      const svc = service({
        replacementListing: {
          groupBy: async (args: { where: unknown }) => {
            askedWhere = args.where;
            return [];
          },
          findMany: async () => [],
        },
        practice: { findMany: async () => [] },
      });

      await svc.findPlaces({ q: "dermatologue" }, 200);

      expect(askedWhere).toMatchObject({
        OR: [
          { title: { contains: "dermatologue", mode: "insensitive" } },
          { description: { contains: "dermatologue", mode: "insensitive" } },
        ],
      });

      await svc.findPlaces({}, 200);
      expect(askedWhere).not.toHaveProperty("OR");
    });

    it("orders the postings the reader asked for, not the server's default", async () => {
      let askedOrderBy: unknown;
      const svc = service({
        replacementListing: {
          groupBy: async () => [],
          findMany: async (args: { orderBy?: unknown }) => {
            askedOrderBy = args.orderBy;
            return [];
          },
        },
        practice: { findMany: async () => [] },
      });

      await svc.findPlaces({ sort: "startDate" }, 200);

      // The map's previews are no longer ordered by the reader's sort — nothing
      // in the map depends on it any more. The reader's *filters* still are, and
      // that is the other half of the test above.
      expect(askedOrderBy).toBeUndefined();
    });

    /**
     * The read that used to be two.
     *
     * Previews and ids both asked the same collection, the second one selecting
     * only the id of every match, so a map of 827 postings paid 827 id rows to
     * learn the position of the one the reader clicked. They are one read now:
     * the preview fields come along for free, and the ids are the same rows in
     * the same order. This pins the shape — one `findMany`, with both the
     * preview columns and the ordering on it — so the two cannot drift apart
     * again without this failing.
     */
    it("reads previews and ids in one query", async () => {
      const asked: Array<Record<string, unknown>> = [];
      const svc = service({
        replacementListing: {
          groupBy: async () => [
            { practiceId: "practice-1", _count: 3 },
            { practiceId: "practice-2", _count: 1 },
          ],
          findMany: async (args: Record<string, unknown>) => {
            asked.push(args);
            return [
              {
                id: "listing-1",
                practiceId: "practice-1",
                title: "One",
                startDate: new Date("2026-01-01"),
                endDate: new Date("2026-01-31"),
              },
              {
                id: "listing-2",
                practiceId: "practice-2",
                title: "Two",
                startDate: new Date("2026-01-01"),
                endDate: new Date("2026-01-31"),
              },
            ];
          },
        },
        practice: {
          findMany: async () => [
            {
              id: "practice-1",
              name: "Cabinet One",
              city: "Lyon",
              latitude: 45.7,
              longitude: 4.8,
            },
            {
              id: "practice-2",
              name: "Cabinet Two",
              city: "Nice",
              latitude: 43.7,
              longitude: 7.2,
            },
          ],
        },
      });

      const result = await svc.findPlaces({}, 200);

      expect(asked).toHaveLength(1);
      expect(asked[0].select).toMatchObject({
        id: true,
        practiceId: true,
        title: true,
        startDate: true,
        endDate: true,
      });
      expect(result.places[0].listings.map((l) => l.id)).toEqual(["listing-1"]);
    });

    /**
     * The previews ask about the places the map draws, and about nothing else.
     *
     * The read used to walk the whole matching collection in the reader's order,
     * because the same query also carried the id of every posting so the browser
     * could find one of them later. A position is asked for now, when it is
     * needed — which leaves this read scoped to the capped practices, and makes
     * it independent of the ordering entirely.
     */
    it("reads previews for the capped practices, and in no particular order", async () => {
      let askedWhere: Record<string, unknown> = {};
      let askedOrderBy: unknown = "unset";
      const svc = service({
        replacementListing: {
          groupBy: async () => [
            { practiceId: "practice-1", _count: 3 },
            { practiceId: "practice-2", _count: 1 },
          ],
          findMany: async (args: Record<string, unknown>) => {
            askedWhere = args.where as Record<string, unknown>;
            askedOrderBy = args.orderBy;
            return [];
          },
        },
        practice: {
          findMany: async () => [
            {
              id: "practice-1",
              name: "Cabinet One",
              city: "Lyon",
              latitude: 45.7,
              longitude: 4.8,
            },
            {
              id: "practice-2",
              name: "Cabinet Two",
              city: "Nice",
              latitude: 43.7,
              longitude: 7.2,
            },
          ],
        },
      });

      await svc.findPlaces({ sort: "urgent" }, 200);

      expect(askedWhere).toMatchObject({
        practiceId: { in: ["practice-1", "practice-2"] },
      });
      expect(askedOrderBy).toBeUndefined();
    });
  });

  describe("orderByFor", () => {
    it("orders by the newest first, with a tiebreaker the paginator can rely on", () => {
      expect(orderByFor(undefined)).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
      expect(orderByFor("recent")).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    });

    it("orders by start date ascending", () => {
      expect(orderByFor("startDate")).toEqual([
        { startDate: "asc" },
        { id: "desc" },
      ]);
    });

    /**
     * Urgent alone is not a total order, and the paginator needs one: two
     * rows sharing `urgent` could land in either order between two pages,
     * which repeats one and skips the other.
     */
    it("breaks the urgent tie on start date, then on id", () => {
      expect(orderByFor("urgent")).toEqual([
        { urgent: "desc" },
        { startDate: "asc" },
        { id: "desc" },
      ]);
    });
  });
});
