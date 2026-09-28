import { ConflictException } from "@nestjs/common";
import type { ApplicationStatus, Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../prisma.service";

const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "PENDING",
  "SHORTLISTED",
];

export async function assertNoThirdPartyApplications(
  prisma: PrismaService,
  ownerProfileId: string,
  listingFilter: Prisma.ReplacementListingWhereInput,
): Promise<void> {
  const count = await prisma.application.count({
    where: {
      listing: listingFilter,
      applicantId: { not: ownerProfileId },
      status: { in: ACTIVE_APPLICATION_STATUSES },
    },
  });

  if (count > 0) {
    throw new ConflictException(
      "This resource has pending applications from other candidates. Close or cancel the linked listings before deleting it.",
    );
  }
}
