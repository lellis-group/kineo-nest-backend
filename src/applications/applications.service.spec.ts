import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
});
