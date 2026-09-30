import { describe, expect, it } from "bun:test";
import {
  ApplicationSchema,
  PaginatedApplicationsSchema,
} from "../entities/application.entity";
import { CreateApplicationSchema } from "./create-application.dto";
import { FindApplicationsSchema } from "./find-applications.dto";
import { RejectApplicationSchema } from "./reject-application.dto";
import { UpdateApplicationSchema } from "./update-application.dto";
import { WithdrawApplicationSchema } from "./withdraw-application.dto";

const LISTING_CUID = "clh8zq6w70000wqf4vlonix5a";

const validApplication = {
  id: "clh8zq6w70000wqf4vlonix5b",
  listingId: "clh8zq6w70000wqf4vlonix5a",
  applicantId: "clh8zq6w70000wqf4vlonix5c",
  status: "PENDING",
  // Nobody has decided yet, so the column is null on a live application.
  decisionSource: null,
  message: null,
  rejectionReason: null,
  withdrawnReason: null,
  viewedAt: null,
  respondedAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

describe("Application DTO security", () => {
  describe("ApplicationSchema", () => {
    it("accepts a bare application without embedded relations", () => {
      expect(ApplicationSchema.safeParse(validApplication).success).toBe(true);
    });

    it("accepts an application with the embedded listing and applicant", () => {
      const result = ApplicationSchema.safeParse({
        ...validApplication,
        listing: {
          id: LISTING_CUID,
          title: "Remplacement de novembre",
          startDate: "2026-11-01T08:00:00.000Z",
          endDate: "2026-11-15T08:00:00.000Z",
          specialty: "DENTIST",
          status: "OPEN",
          urgent: false,
          description: "Cabinet moderne, patientèle fidèle.",
          practice: {
            id: "clh8zq6w70000wqf4vlonix5d",
            name: "Cabinet des Lilas",
            address: "12 rue de la Paix",
            city: "Lyon",
            latitude: 45.75,
            longitude: 4.85,
          },
        },
        applicant: {
          id: "clh8zq6w70000wqf4vlonix5c",
          specialty: "DENTIST",
          profileType: "REPLACEMENT",
          city: "Paris",
          verified: true,
          user: { name: "Alice Martin", image: null },
          anonymized: false,
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects an applicant without the anonymized flag", () => {
      const result = ApplicationSchema.safeParse({
        ...validApplication,
        applicant: {
          id: "clh8zq6w70000wqf4vlonix5c",
          specialty: "DENTIST",
          profileType: "REPLACEMENT",
          city: null,
          verified: false,
          user: { name: null, image: null },
        },
      });

      // Required, not optional: the practice must always be able to tell a
      // blank card apart from an erased candidate.
      expect(result.success).toBe(false);
    });
  });

  describe("PaginatedApplicationsSchema", () => {
    /** The two count maps, over the same three applications. */
    const validMeta = {
      total: 3,
      page: 1,
      limit: 20,
      totalPages: 1,
      counts: {
        total: 3,
        PENDING: 2,
        SHORTLISTED: 0,
        ACCEPTED: 0,
        REJECTED: 1,
        WITHDRAWN: 0,
      },
      decisionCounts: {
        total: 3,
        CANDIDATE_WITHDREW: 0,
        PRACTICE_ACCEPTED: 0,
        // The one rejection, and the practice wrote it themselves.
        PRACTICE_REJECTED: 1,
        ANOTHER_CANDIDATE_SELECTED: 0,
        LISTING_CLOSED: 0,
        LISTING_CLOSED_NO_CANDIDATE: 0,
        LISTING_CANCELLED: 0,
        LISTING_ERASED: 0,
        CANDIDATE_UNAVAILABLE: 0,
        // The two still open: `decisionSource` is null, which groupBy cannot
        // key on, so it gets its own bucket.
        undecided: 2,
      },
    };

    it("accepts a paginated response with server-computed status counts", () => {
      const result = PaginatedApplicationsSchema.safeParse({
        data: [validApplication],
        meta: validMeta,
      });
      expect(result.success).toBe(true);
    });

    it("rejects decision counts missing a source", () => {
      // A dropped key would be a filter whose count is silently wrong, and the
      // applicant's tab counter is the only place it would show.
      const { CANDIDATE_WITHDREW: _dropped, ...partial } =
        validMeta.decisionCounts;
      const result = PaginatedApplicationsSchema.safeParse({
        data: [validApplication],
        meta: { ...validMeta, decisionCounts: partial },
      });
      expect(result.success).toBe(false);
    });

    it("rejects counts missing a status", () => {
      const result = PaginatedApplicationsSchema.safeParse({
        data: [validApplication],
        meta: {
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          counts: {
            total: 1,
            PENDING: 1,
            SHORTLISTED: 0,
            ACCEPTED: 0,
            REJECTED: 0,
          },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateApplicationSchema", () => {
    it("accepts a valid application", () => {
      expect(
        CreateApplicationSchema.safeParse({ listingId: LISTING_CUID }).success,
      ).toBe(true);
    });

    it("rejects unknown keys (mass-assignment protection)", () => {
      const result = CreateApplicationSchema.safeParse({
        listingId: LISTING_CUID,
        status: "ACCEPTED",
        applicantId: "profile-1",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a listingId that is not a Prisma cuid", () => {
      expect(
        CreateApplicationSchema.safeParse({
          listingId: "not-a-cuid",
        }).success,
      ).toBe(false);
    });

    it("trims and bounds the message", () => {
      const result = CreateApplicationSchema.safeParse({
        listingId: LISTING_CUID,
        message: "  Bonjour, je suis disponible.  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.message).toBe("Bonjour, je suis disponible.");
      }

      expect(
        CreateApplicationSchema.safeParse({
          listingId: LISTING_CUID,
          message: "   ",
        }).success,
      ).toBe(false);

      expect(
        CreateApplicationSchema.safeParse({
          listingId: LISTING_CUID,
          message: "x".repeat(2001),
        }).success,
      ).toBe(false);
    });

    it("allows newlines but rejects invisible control characters in the message", () => {
      const withNewline = CreateApplicationSchema.safeParse({
        listingId: LISTING_CUID,
        message: "Bonjour\nDisponible en septembre.",
      });
      expect(withNewline.success).toBe(true);

      const withZeroWidth = CreateApplicationSchema.safeParse({
        listingId: LISTING_CUID,
        message: "Bonjour\u200Bcaché",
      });
      expect(withZeroWidth.success).toBe(false);
    });
  });

  describe("UpdateApplicationSchema", () => {
    it("rejects unknown keys", () => {
      expect(
        UpdateApplicationSchema.safeParse({
          message: "New message",
          status: "WITHDRAWN",
        }).success,
      ).toBe(false);
    });

    it("requires a non-empty trimmed message", () => {
      expect(
        UpdateApplicationSchema.safeParse({ message: "  Updated  " }).success,
      ).toBe(true);
      expect(
        UpdateApplicationSchema.safeParse({ message: "   " }).success,
      ).toBe(false);
      expect(UpdateApplicationSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("RejectApplicationSchema", () => {
    it("rejects unknown keys and trims the reason", () => {
      expect(
        RejectApplicationSchema.safeParse({
          rejectionReason: "Pas disponible",
          respondedAt: "2026-09-01T00:00:00.000Z",
        }).success,
      ).toBe(false);

      const result = RejectApplicationSchema.safeParse({
        rejectionReason: "  Pas disponible  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rejectionReason).toBe("Pas disponible");
      }
    });
  });

  describe("WithdrawApplicationSchema", () => {
    it("rejects unknown keys and trims the reason", () => {
      expect(
        WithdrawApplicationSchema.safeParse({
          withdrawnReason: "Autre opportunité",
          status: "WITHDRAWN",
        }).success,
      ).toBe(false);

      const result = WithdrawApplicationSchema.safeParse({
        withdrawnReason: " Autre opportunité ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.withdrawnReason).toBe("Autre opportunité");
      }
    });
  });

  describe("FindApplicationsSchema", () => {
    it("rejects unknown query parameters", () => {
      expect(
        FindApplicationsSchema.safeParse({ applicantId: "profile-1" }).success,
      ).toBe(false);
    });

    it("accepts known filters and coerces integer pagination", () => {
      const result = FindApplicationsSchema.safeParse({
        listingId: LISTING_CUID,
        status: "PENDING",
        page: "2",
        limit: "25",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.limit).toBe(25);
      }
    });

    it("rejects a non-cuid listingId filter", () => {
      expect(
        FindApplicationsSchema.safeParse({ listingId: "nope" }).success,
      ).toBe(false);
    });

    it("rejects pagination deeper than 10,000 results", () => {
      expect(
        FindApplicationsSchema.safeParse({ page: "200", limit: "100" }).success,
      ).toBe(false);
      expect(
        FindApplicationsSchema.safeParse({ page: "100", limit: "100" }).success,
      ).toBe(true);
    });

    /**
     * The applicant's buckets span several statuses or several decision
     * sources, so the filter takes a comma-separated list. It stays an array
     * even for one value, which is what lets the service build either an
     * equality or an `in` without the caller knowing which it sent.
     */
    it("accepts a comma-separated status list", () => {
      const result = FindApplicationsSchema.safeParse({
        status: "REJECTED,WITHDRAWN",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toEqual(["REJECTED", "WITHDRAWN"]);
      }
    });

    it("keeps a single status as a one-element list", () => {
      const result = FindApplicationsSchema.safeParse({ status: "PENDING" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toEqual(["PENDING"]);
      }
    });

    it("rejects a status the enum does not have", () => {
      expect(
        FindApplicationsSchema.safeParse({ status: "PENDING,NOPE" }).success,
      ).toBe(false);
    });

    it("rejects an empty list", () => {
      // `status=` would otherwise become `in: []`, which matches nothing and
      // reads to the caller as "no filter" on a screen that shows a count.
      expect(FindApplicationsSchema.safeParse({ status: "" }).success).toBe(
        false,
      );
      expect(
        FindApplicationsSchema.safeParse({ status: "PENDING," }).success,
      ).toBe(false);
    });

    it("filters by decision source", () => {
      const result = FindApplicationsSchema.safeParse({
        status: "REJECTED",
        decisionSource:
          "PRACTICE_REJECTED,LISTING_CLOSED,LISTING_CLOSED_NO_CANDIDATE,LISTING_CANCELLED",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionSource).toHaveLength(4);
      }
    });

    it("rejects a decision source the enum does not have", () => {
      expect(
        FindApplicationsSchema.safeParse({ decisionSource: "NOPE" }).success,
      ).toBe(false);
    });
  });
});
