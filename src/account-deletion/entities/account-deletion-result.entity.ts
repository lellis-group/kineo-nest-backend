import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const AccountDeletionResultSchema = z
  .object({
    success: z.literal(true).describe("The account has been anonymized"),
    anonymizedAt: z.iso.datetime().describe("When the account was anonymized"),
    anonymizedListings: z
      .number()
      .describe("Own listings taken out of circulation"),
    detachedApplications: z
      .number()
      .describe(
        "Applications from other candidates, kept on a ghost listing because they are not ours to erase",
      ),
    settledApplications: z
      .number()
      .describe("Own applications settled so their listings recalculate"),
    protectedPlacements: z
      .number()
      .describe("Listings holding an accepted placement, left untouched"),
    message: z
      .string()
      .describe("Confirmation message, in the language of the interface"),
  })
  .strict();

export class AccountDeletionResult extends createZodDto(
  AccountDeletionResultSchema,
) {}
