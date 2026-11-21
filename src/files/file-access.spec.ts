import { describe, expect, it } from "bun:test";
import type { PrismaService } from "../prisma.service";
import { canReadFile } from "./file-access";

type Subject = Parameters<typeof canReadFile>[1];

function client(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      findUnique: async ({ where }: { where: Record<string, string> }) => {
        if ("userId" in where) {
          return where.userId === "u-owner" ? { id: "p-owner" } : null;
        }
        return { id: where.id, isPublic: true };
      },
    },
    replacementListing: {
      findUnique: async () => ({
        status: "OPEN",
        createdById: "p-owner",
        practice: { isPublic: true, ownerId: "p-owner" },
      }),
    },
    application: {
      findUnique: async () => ({
        applicantId: "p-candidate",
        listing: { practice: { ownerId: "p-owner" } },
      }),
    },
    ...overrides,
  } as unknown as PrismaService;
}

const avatar: Subject = {
  kind: "AVATAR",
  profileId: "p-owner",
  listingId: null,
  applicationId: null,
};
const listingImage: Subject = {
  kind: "LISTING_IMAGE",
  profileId: null,
  listingId: "l-1",
  applicationId: null,
};
const profileCv: Subject = {
  kind: "CV",
  profileId: "p-candidate",
  listingId: null,
  applicationId: null,
};
const applicationCv: Subject = {
  kind: "CV",
  profileId: null,
  listingId: null,
  applicationId: "a-1",
};

describe("canReadFile", () => {
  it("lets anyone read a public avatar, and its owner read a private one", async () => {
    expect(await canReadFile(client(), avatar, "u-stranger")).toBe(true);

    const privateAvatar = client({
      profile: {
        findUnique: async ({ where }: { where: Record<string, string> }) =>
          "userId" in where
            ? where.userId === "u-owner"
              ? { id: "p-owner" }
              : null
            : { id: where.id, isPublic: false },
      },
    });
    expect(await canReadFile(privateAvatar, avatar, "u-owner")).toBe(true);
    expect(await canReadFile(privateAvatar, avatar, "u-stranger")).toBe(false);
  });

  it("shows listing photos on a public applicable listing, and to its owner", async () => {
    expect(await canReadFile(client(), listingImage, "u-stranger")).toBe(true);

    const closed = client({
      replacementListing: {
        findUnique: async () => ({
          status: "CLOSED",
          createdById: "p-owner",
          practice: { isPublic: true, ownerId: "p-owner" },
        }),
      },
    });
    expect(await canReadFile(closed, listingImage, "u-stranger")).toBe(false);
    expect(await canReadFile(closed, listingImage, "u-owner")).toBe(true);
  });

  it("keeps a profile CV private to its owner", async () => {
    expect(await canReadFile(client(), profileCv, "u-owner")).toBe(false);
    expect(await canReadFile(client(), profileCv, undefined)).toBe(false);

    const candidate = client({
      profile: {
        findUnique: async ({ where }: { where: Record<string, string> }) =>
          where.userId === "u-candidate" ? { id: "p-candidate" } : null,
      },
    });
    expect(await canReadFile(candidate, profileCv, "u-candidate")).toBe(true);
  });

  it("lets only the applicant and the practice owner read an application CV", async () => {
    const ownerClient = client();
    expect(await canReadFile(ownerClient, applicationCv, "u-owner")).toBe(true);

    const candidate = client({
      profile: {
        findUnique: async ({ where }: { where: Record<string, string> }) =>
          where.userId === "u-candidate" ? { id: "p-candidate" } : null,
      },
    });
    expect(await canReadFile(candidate, applicationCv, "u-candidate")).toBe(
      true,
    );
    expect(await canReadFile(ownerClient, applicationCv, "u-stranger")).toBe(
      false,
    );
    expect(await canReadFile(ownerClient, applicationCv, undefined)).toBe(
      false,
    );
  });

  it("refuses a file whose owner is missing", async () => {
    const broken: Subject = {
      kind: "CV",
      profileId: null,
      listingId: null,
      applicationId: null,
    };
    expect(await canReadFile(client(), broken, "u-owner")).toBe(false);
  });
});
