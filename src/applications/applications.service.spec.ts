import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ACTIVE_APPLICATION_STATUSES } from "../common/listing-status";
import { REFUSAL_CODES } from "../common/refusal";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma.service";
import { ApplicationsService } from "./applications.service";

describe("ApplicationsService", () => {
  it("accepts an application in a serializable transaction and rejects active alternatives", async () => {
    let transactionOptions: unknown;
    let rejectedAlternatives = false;
    const application = {
      id: "application-1",
      listingId: "listing-1",
      applicantId: "applicant-1",
      status: "PENDING",
      message: null,
      rejectionReason: null,
      withdrawnReason: null,
      viewedAt: null,
      respondedAt: null,
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    };
    const transactionClient = {
      profile: { findUnique: async () => ({ id: "owner-1" }) },
      application: {
        findUnique: async () => application,
        update: async () => ({
          ...application,
          status: "ACCEPTED",
          respondedAt: new Date(),
        }),
        updateMany: async () => {
          rejectedAlternatives = true;
          return { count: 1 };
        },
      },
      replacementListing: {
        findUnique: async () => ({
          id: "listing-1",
          createdById: "owner-1",
          status: "IN_DISCUSSION",
        }),
        update: async () => ({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
        options: unknown,
      ) => {
        transactionOptions = options;
        return operation(transactionClient);
      },
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ApplicationsService(prisma, config);

    const result = await service.accept("application-1", "owner-user-1");

    expect(result.status).toBe("ACCEPTED");
    expect(rejectedAlternatives).toBe(true);
    expect(transactionOptions).toMatchObject({
      isolationLevel: "Serializable",
    });
  });

  it("rejects an application and recalculates listing status", async () => {
    const application = {
      id: "application-2",
      listingId: "listing-2",
      applicantId: "applicant-2",
      status: "PENDING",
      message: null,
      rejectionReason: null,
      withdrawnReason: null,
      viewedAt: null,
      respondedAt: null,
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    };
    const listingStatusUpdates: string[] = [];
    const transactionClient = {
      profile: { findUnique: async () => ({ id: "owner-1" }) },
      application: {
        findUnique: async () => application,
        update: async () => ({
          ...application,
          status: "REJECTED",
          rejectionReason: "Not a good fit",
          respondedAt: new Date(),
        }),
        count: async () => 0,
      },
      replacementListing: {
        findUnique: async () => ({
          id: "listing-2",
          createdById: "owner-1",
          status: "IN_DISCUSSION",
          maxApplications: null,
        }),
        update: async ({ data }: { data: { status: string } }) => {
          listingStatusUpdates.push(data.status);
          return { ...application, ...data };
        },
      },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ApplicationsService(prisma, config);

    const result = await service.reject("application-2", "owner-user-1", {
      rejectionReason: "Not a good fit",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.rejectionReason).toBe("Not a good fit");
    expect(listingStatusUpdates).toEqual(["OPEN"]);
  });

  it("throws NotFoundException when application does not exist", async () => {
    const transactionClient = {
      application: { findUnique: async () => null },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ApplicationsService(prisma, config);

    await expect(
      service.reject("nonexistent", "owner-user-1", {
        rejectionReason: "test",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws BadRequestException when rejecting a non-pending application", async () => {
    const application = {
      id: "application-3",
      listingId: "listing-3",
      applicantId: "applicant-3",
      status: "ACCEPTED",
      message: null,
      rejectionReason: null,
      withdrawnReason: null,
      viewedAt: null,
      respondedAt: new Date(),
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    };
    const transactionClient = {
      profile: { findUnique: async () => ({ id: "owner-1" }) },
      application: { findUnique: async () => application },
      replacementListing: {
        findUnique: async () => ({
          id: "listing-3",
          createdById: "owner-1",
          status: "FILLED",
        }),
      },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ApplicationsService(prisma, config);

    await expect(
      service.reject("application-3", "owner-user-1", {
        rejectionReason: "test",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * One rule, three actions: hide the application from someone who is not part
   * of it, and tell the two who are when it is not their turn.
   *
   * `accept` used to fold both cases into its 404, so an applicant asking to
   * accept their own application was told it did not exist — of their own
   * application, which they could see on screen.
   */
  describe("who may decide", () => {
    const application = {
      id: "application-1",
      listingId: "listing-1",
      applicantId: "applicant-1",
      status: "PENDING",
    };

    function serviceWith(profileId: string, listingOwnerId: string) {
      const transactionClient = {
        profile: { findUnique: async () => ({ id: profileId }) },
        application: { findUnique: async () => application },
        replacementListing: {
          findUnique: async () => ({
            id: "listing-1",
            createdById: listingOwnerId,
            status: "OPEN",
          }),
        },
      };
      const prisma = {
        $transaction: async (
          operation: (tx: typeof transactionClient) => unknown,
        ) => operation(transactionClient),
      } as unknown as PrismaService;
      return new ApplicationsService(prisma, {
        get: () => undefined,
      } as unknown as ConfigService);
    }

    const actions: Array<
      [string, (s: ApplicationsService) => Promise<unknown>]
    > = [
      ["accept", (s) => s.accept("application-1", "caller-user")],
      [
        "reject",
        (s) =>
          s.reject("application-1", "caller-user", { rejectionReason: "x" }),
      ],
      [
        "withdraw",
        (s) =>
          s.withdraw("application-1", "caller-user", { withdrawnReason: "x" }),
      ],
    ];

    for (const [name, call] of actions) {
      it(`${name} answers 404 to a caller who is neither applicant nor owner`, async () => {
        await expect(
          call(serviceWith("profile-stranger", "owner-1")),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    }

    it("accept answers 403 to the applicant, who is not the owner", async () => {
      await expect(
        actions[0][1](serviceWith("applicant-1", "owner-1")),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("reject answers 403 to the applicant, who is not the owner", async () => {
      await expect(
        actions[1][1](serviceWith("applicant-1", "owner-1")),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("withdraw answers 403 to the owner, who is not the applicant", async () => {
      await expect(
        actions[2][1](serviceWith("owner-1", "owner-1")),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it("withdraws an application and recalculates listing status", async () => {
    const application = {
      id: "application-4",
      listingId: "listing-4",
      applicantId: "applicant-4",
      status: "PENDING",
      message: null,
      rejectionReason: null,
      withdrawnReason: null,
      viewedAt: null,
      respondedAt: null,
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    };
    const listingStatusUpdates: string[] = [];
    const transactionClient = {
      profile: { findUnique: async () => ({ id: "applicant-4" }) },
      application: {
        findUnique: async () => application,
        update: async () => ({
          ...application,
          status: "WITHDRAWN",
          withdrawnReason: "Found another opportunity",
        }),
        count: async () => 0,
      },
      replacementListing: {
        findUnique: async () => ({
          id: "listing-4",
          createdById: "owner-1",
          status: "IN_DISCUSSION",
          maxApplications: null,
        }),
        update: async ({ data }: { data: { status: string } }) => {
          listingStatusUpdates.push(data.status);
          return { ...application, ...data };
        },
      },
    };
    const prisma = {
      $transaction: async (
        operation: (tx: typeof transactionClient) => unknown,
      ) => operation(transactionClient),
    } as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new ApplicationsService(prisma, config);

    const result = await service.withdraw("application-4", "applicant-user-4", {
      withdrawnReason: "Found another opportunity",
    });

    expect(result.status).toBe("WITHDRAWN");
    expect(result.withdrawnReason).toBe("Found another opportunity");
    expect(listingStatusUpdates).toEqual(["OPEN"]);
  });

  /**
   * The counters `findMine` sends beside the page.
   *
   * They describe the whole collection, never the filtered slice the caller
   * asked for: a chip that counted what it just filtered would read as the page
   * size. The two added ones are the same kind of figure, and a client that had
   * to page a collection to compute them was one page short of the truth past
   * twenty. So the predicates are asserted here rather than the numbers, which
   * only a real database could answer honestly.
   */
  describe("findMine", () => {
    type CountWhere = Record<string, unknown>;

    /** Records every `count` predicate, and answers a constant for all of them. */
    function serviceRecordingCounts() {
      const predicates: CountWhere[] = [];
      const prisma = {
        profile: { findUnique: async () => ({ id: "applicant-1" }) },
        application: {
          findMany: async () => [],
          groupBy: async () => [],
          count: async ({ where }: { where: CountWhere }) => {
            predicates.push(where);
            return 0;
          },
        },
      } as unknown as PrismaService;

      return {
        predicates,
        service: new ApplicationsService(prisma, {
          get: () => undefined,
        } as unknown as ConfigService),
      };
    }

    const countsBy = (predicates: CountWhere[], predicate: CountWhere) =>
      predicates.filter((where) =>
        Object.entries(predicate).every(
          ([key, value]) =>
            JSON.stringify(where[key]) === JSON.stringify(value),
        ),
      );

    it("counts the open applications nobody has opened, not the filtered slice", async () => {
      const { predicates, service } = serviceRecordingCounts();

      await service.findMine("user-1", {
        page: 1,
        limit: 20,
        status: "ACCEPTED",
      });

      expect(
        countsBy(predicates, {
          status: { in: ["PENDING", "SHORTLISTED"] },
          viewedAt: null,
        }),
      ).toHaveLength(1);
    });

    it("counts answered applications without counting withdrawn ones", async () => {
      const { predicates, service } = serviceRecordingCounts();

      await service.findMine("user-1", {
        page: 1,
        limit: 20,
        status: "ACCEPTED",
      });

      expect(
        countsBy(predicates, {
          status: { not: "WITHDRAWN" },
          respondedAt: { not: null },
        }),
      ).toHaveLength(1);
    });

    it("scopes every counter to the applicant, whatever the filter", async () => {
      const { predicates, service } = serviceRecordingCounts();

      await service.findMine("user-1", {
        page: 1,
        limit: 20,
        status: "ACCEPTED",
        bucket: "REFUSED",
      });

      for (const where of predicates) {
        expect(where.applicantId).toBe("applicant-1");
      }
    });

    it("returns both counters in the meta", async () => {
      const { service } = serviceRecordingCounts();

      const result = await service.findMine("user-1", { page: 1, limit: 20 });

      expect(result.meta.unseenOpenCount).toBe(0);
      expect(result.meta.respondedCount).toBe(0);
    });
  });

  /**
   * `create` is the only write on this resource that opens a decision loop, and
   * every one of its refusals is a rule about somebody else's row — the
   * candidate's own quota, the practice's cap, the posting's status. They are
   * asserted here as refusals rather than as thrown errors, because the code is
   * what a client switches on: a 400 without `code` is a 400 the frontend
   * cannot explain.
   */
  describe("create", () => {
    const candidate = { id: "applicant-1", profileType: "REPLACEMENT" };

    const openListing = {
      id: "listing-1",
      createdById: "owner-1",
      status: "OPEN",
      maxApplications: null,
    };

    interface CreateOptions {
      profile?: unknown;
      listing?: unknown;
      /** Active applications, counted for the quota and then for the listing. */
      activeCount?: number;
      /** The configured per-profile quota; unset means no quota at all. */
      maxActive?: number;
      /** Overrides what `application.create` writes. */
      onCreate?: () => Promise<unknown>;
      listingRead?: () => unknown;
    }

    function serviceFor(options: CreateOptions = {}) {
      const counts: Record<string, unknown>[] = [];
      let writtenData: Record<string, unknown> | undefined;
      let listingStatus: string | undefined;

      const tx = {
        application: {
          count: async ({ where }: { where: Record<string, unknown> }) => {
            counts.push(where);
            return options.activeCount ?? 0;
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            writtenData = data;
            return options.onCreate
              ? options.onCreate()
              : {
                  id: "application-1",
                  ...data,
                  status: "PENDING",
                  rejectionReason: null,
                  withdrawnReason: null,
                  viewedAt: null,
                  respondedAt: null,
                  createdAt: new Date("2026-08-20T08:00:00.000Z"),
                  updatedAt: new Date("2026-08-20T08:00:00.000Z"),
                };
          },
        },
        replacementListing: {
          // `??` would turn a deliberate `null` back into the default row: a
          // missing listing is passed as `null`, not left out.
          findUnique: async () =>
            options.listingRead
              ? options.listingRead()
              : options.listing !== undefined
                ? options.listing
                : openListing,
          update: async ({ data }: { data: { status: string } }) => {
            listingStatus = data.status;
            return { ...openListing, ...data };
          },
        },
      };

      const prisma = {
        profile: { findUnique: async () => options.profile ?? candidate },
        $transaction: async (operation: (client: typeof tx) => unknown) =>
          operation(tx),
      } as unknown as PrismaService;

      const config = {
        get: (key: string) =>
          key === "limits.activeApplicationsPerProfile"
            ? options.maxActive
            : undefined,
      } as unknown as ConfigService;

      return {
        counts,
        writtenData: () => writtenData,
        listingStatus: () => listingStatus,
        service: new ApplicationsService(prisma, config),
      };
    }

    /** The code a refusal carries, having asserted it was a 400. */
    async function refusalCodeOf(call: Promise<unknown>) {
      const error = await call.then(
        () => null,
        (caught: unknown) => caught as BadRequestException,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      return (error?.getResponse() as { code?: string }).code;
    }

    it("records the application and moves the listing into discussion", async () => {
      const { listingStatus, service, writtenData } = serviceFor();

      const result = await service.create("user-1", {
        listingId: "listing-1",
        message: "I am available.",
      });

      expect(result.status).toBe("PENDING");
      expect(writtenData()).toMatchObject({
        listingId: "listing-1",
        applicantId: "applicant-1",
        message: "I am available.",
      });
      // One application on an uncapped posting: the practice has something to
      // look at, so the posting is no longer just advertised.
      expect(listingStatus()).toBe("IN_DISCUSSION");
    });

    it("fills the listing the application brings it to its cap", async () => {
      const { listingStatus, service } = serviceFor({
        listing: { ...openListing, maxApplications: 1 },
        activeCount: 0,
      });

      await service.create("user-1", { listingId: "listing-1" });

      // The count the cap was read against excludes the application being
      // created, and the derivation is handed the one that includes it.
      expect(listingStatus()).toBe("FULL");
    });

    it("refuses an INSTALLED profile before it reads anything else", async () => {
      let listingRead = false;
      const { service } = serviceFor({
        profile: { id: "owner-1", profileType: "INSTALLED" },
        listingRead: () => {
          listingRead = true;
          return openListing;
        },
      });

      await expect(
        service.create("user-1", { listingId: "listing-1" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listingRead).toBe(false);
    });

    it("refuses a candidate who already holds as many active applications as allowed", async () => {
      const { service } = serviceFor({ maxActive: 2, activeCount: 2 });

      const code = await refusalCodeOf(
        service.create("user-1", { listingId: "listing-1" }),
      );

      expect(code).toBe(REFUSAL_CODES.applicationQuotaReached);
    });

    it("counts the candidate's own active applications against the quota, by status", async () => {
      const { counts, service } = serviceFor({ maxActive: 2, activeCount: 1 });

      await service.create("user-1", { listingId: "listing-1" });

      expect(counts[0]).toEqual({
        applicantId: "applicant-1",
        status: { in: ACTIVE_APPLICATION_STATUSES },
      });
    });

    it("answers 404 to a listing that does not exist", async () => {
      const { service } = serviceFor({ listing: null });

      await expect(
        service.create("user-1", { listingId: "nonexistent" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses a candidate applying to their own posting", async () => {
      const { service } = serviceFor({
        listing: { ...openListing, createdById: "applicant-1" },
      });

      await expect(
        service.create("user-1", { listingId: "listing-1" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses a posting that has left circulation", async () => {
      const { service } = serviceFor({
        listing: { ...openListing, status: "FILLED" },
      });

      const code = await refusalCodeOf(
        service.create("user-1", { listingId: "listing-1" }),
      );

      expect(code).toBe(REFUSAL_CODES.applicationListingNotAccepting);
    });

    it("refuses an application over a posting whose cap is already reached", async () => {
      const { service } = serviceFor({
        listing: { ...openListing, maxApplications: 1 },
        activeCount: 1,
      });

      const code = await refusalCodeOf(
        service.create("user-1", { listingId: "listing-1" }),
      );

      expect(code).toBe(REFUSAL_CODES.applicationListingLimitReached);
    });

    /**
     * The database's own uniqueness answer, translated.
     *
     * The check that can settle a double application is a unique index the
     * service does not read before writing, so two submissions that pass every
     * rule above both reach the insert and one of them loses. That loser used to
     * leave the API with a 500 on a conflict the user caused and could fix.
     */
    it("answers 409 with a stable code when the unique index loses the race", async () => {
      const { service } = serviceFor({
        onCreate: async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields (listingId, applicantId)",
            { code: "P2002", clientVersion: "test" },
          );
        },
      });

      const error = await service
        .create("user-1", { listingId: "listing-1" })
        .then(
          () => null,
          (caught: unknown) => caught as ConflictException,
        );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error?.getResponse() as { statusCode?: number }).statusCode).toBe(
        409,
      );
      expect((error?.getResponse() as { code?: string }).code).toBe(
        REFUSAL_CODES.applicationAlreadyExists,
      );
    });
  });

  /**
   * The inbox a practice reads. What it can get wrong is answering it to the
   * wrong reader: the ownership check sits *before* the reads, so a candidate
   * asking for somebody else's inbox gets 403 and a stranger asking for a
   * listing that does not exist gets 404 — the two are told apart on purpose.
   */
  describe("findForListing", () => {
    function serviceFor(profileId: string, listing: unknown) {
      const reads: { where?: unknown; orderBy?: unknown } = {};
      const prisma = {
        profile: { findUnique: async () => ({ id: profileId }) },
        replacementListing: { findUnique: async () => listing },
        application: {
          findMany: async (args: { where: unknown; orderBy: unknown }) => {
            reads.where = args.where;
            reads.orderBy = args.orderBy;
            return [];
          },
          count: async () => 0,
          groupBy: async () => [],
        },
      } as unknown as PrismaService;

      return {
        reads,
        service: new ApplicationsService(prisma, {
          get: () => undefined,
        } as unknown as ConfigService),
      };
    }

    const listing = { id: "listing-1", createdById: "owner-1" };

    it("answers 404 for a listing that does not exist", async () => {
      const { service } = serviceFor("owner-1", null);

      await expect(
        service.findForListing("nonexistent", "user-1", { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers 403 to a caller who does not own the listing", async () => {
      const { service } = serviceFor("candidate-1", listing);

      await expect(
        service.findForListing("listing-1", "user-1", { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("pages the owner's applications with the caller's status filter", async () => {
      const { reads, service } = serviceFor("owner-1", listing);

      const result = await service.findForListing("listing-1", "user-1", {
        page: 2,
        limit: 5,
        status: "PENDING",
      } as never);

      expect(reads.where).toEqual({
        listingId: "listing-1",
        status: "PENDING",
      });
      // `createdAt` alone is not a total order, so the id breaks the tie between
      // two pages: offset pagination otherwise repeats one row and skips one.
      expect(reads.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
      expect(result.meta).toMatchObject({ page: 2, limit: 5, total: 0 });
      expect(result.meta.counts).toMatchObject({ total: 0 });
    });
  });

  /**
   * The three writes that belong to one side of the conversation: the practice
   * opens and shortlists, the candidate edits. Both resolve the same access rule
   * first — 404 for a stranger, 403 for the other side — and the e2e suite proves
   * the routes answer; what is pinned here is that the *service* refuses the
   * same way when called without the HTTP layer in the way.
   */
  describe("opening and shortlisting, on one side only", () => {
    const application = {
      id: "application-1",
      listingId: "listing-1",
      applicantId: "applicant-1",
      status: "PENDING",
      message: null,
      rejectionReason: null,
      withdrawnReason: null,
      viewedAt: null,
      respondedAt: null,
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    };

    /**
     * The row `assertAccess` reads: with the two relations it walks, in the
     * shape the mapper publishes them. Half a relation is not a fixture here —
     * the mapper reads every field of both, so a stubbed listing without a
     * `startDate` fails on the DTO rather than on the rule under test.
     */
    const readable = {
      ...application,
      listing: {
        id: "listing-1",
        createdById: "owner-1",
        title: "General practitioner cover",
        startDate: new Date("2026-11-01T08:00:00.000Z"),
        endDate: new Date("2026-11-04T08:00:00.000Z"),
        specialty: "GENERALIST",
        status: "OPEN",
        urgent: false,
        description: null,
        practice: {
          id: "practice-1",
          name: "Cabinet Medical",
          address: "1 rue de la Paix",
          city: "Lyon",
          latitude: null,
          longitude: null,
        },
      },
      applicant: {
        id: "applicant-1",
        specialty: "GENERALIST",
        profileType: "REPLACEMENT",
        city: "Lyon",
        verified: true,
        user: { name: null, image: null },
      },
    };

    function serviceFor(profileId: string, row: unknown) {
      const writes: Array<Record<string, unknown>> = [];
      const prisma = {
        profile: { findUnique: async () => ({ id: profileId }) },
        application: {
          findUnique: async () => row,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            writes.push(data);
            return { ...application, ...data };
          },
        },
      } as unknown as PrismaService;

      return {
        writes,
        service: new ApplicationsService(prisma, {
          get: () => undefined,
        } as unknown as ConfigService),
      };
    }

    it("answers 404 to a caller who is neither applicant nor owner", async () => {
      const { service } = serviceFor("profile-stranger", readable);

      await expect(
        service.findOne("application-1", "user-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers 404 to a caller asking about an application that does not exist", async () => {
      const { service } = serviceFor("owner-1", null);

      await expect(
        service.findOne("application-1", "user-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers the applicant's own application to them", async () => {
      const { service } = serviceFor("applicant-1", readable);

      const result = await service.findOne("application-1", "user-1");

      expect(result.id).toBe("application-1");
    });

    it("lets only the owner mark it viewed", async () => {
      const { service } = serviceFor("applicant-1", readable);

      await expect(
        service.markAsViewed("application-1", "user-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("keeps the first viewed stamp instead of redating it", async () => {
      const viewedAt = new Date("2026-08-20T09:00:00.000Z");
      const { writes, service } = serviceFor("owner-1", {
        ...readable,
        viewedAt,
      });

      const result = await service.markAsViewed("application-1", "user-1");

      // A second visit is not a second opening: the dashboard's "unseen" figure
      // counts views, and redating would let a practice clear the badge by
      // reloading the page.
      expect(String(result.viewedAt)).toBe(viewedAt.toISOString());
      expect(writes).toHaveLength(0);
    });

    it("stamps the first view for the owner", async () => {
      const { writes, service } = serviceFor("owner-1", readable);

      const result = await service.markAsViewed("application-1", "user-1");

      expect(result.viewedAt).not.toBeNull();
      expect(writes[0]).toHaveProperty("viewedAt");
    });

    it("lets only the owner shortlist", async () => {
      const { service } = serviceFor("applicant-1", readable);

      await expect(
        service.shortlist("application-1", "user-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses to shortlist an application that has been answered", async () => {
      const { service } = serviceFor("owner-1", {
        ...readable,
        status: "ACCEPTED",
      });

      const error = await service.shortlist("application-1", "user-1").then(
        () => null,
        (caught: unknown) => caught as BadRequestException,
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error?.getResponse() as { code?: string }).code).toBe(
        REFUSAL_CODES.applicationNotShortlistable,
      );
    });

    it("shortlists for the owner, stamping the answer time", async () => {
      const { writes, service } = serviceFor("owner-1", readable);

      const result = await service.shortlist("application-1", "user-1");

      expect(result.status).toBe("SHORTLISTED");
      expect(writes[0]).toMatchObject({ status: "SHORTLISTED" });
      expect(writes[0]?.respondedAt).toBeInstanceOf(Date);
    });

    it("lets only the applicant edit the message", async () => {
      const { service } = serviceFor("owner-1", readable);

      await expect(
        service.update("application-1", "user-1", { message: "edit" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses to edit an application that has been answered", async () => {
      const { service } = serviceFor("applicant-1", {
        ...readable,
        status: "SHORTLISTED",
      });

      const error = await service
        .update("application-1", "user-1", { message: "edit" })
        .then(
          () => null,
          (caught: unknown) => caught as BadRequestException,
        );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error?.getResponse() as { code?: string }).code).toBe(
        REFUSAL_CODES.applicationNotPending,
      );
    });

    it("writes the edited message for the applicant", async () => {
      const { writes, service } = serviceFor("applicant-1", readable);

      const result = await service.update("application-1", "user-1", {
        message: "Evenings only now.",
      });

      expect(result.message).toBe("Evenings only now.");
      expect(writes).toEqual([{ message: "Evenings only now." }]);
    });
  });
});
