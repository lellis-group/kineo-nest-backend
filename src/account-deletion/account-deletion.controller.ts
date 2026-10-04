import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { ThrottleWithConfig } from "../common/decorators/throttle-with-config.decorator";
import { AccountDeletionService } from "./account-deletion.service";
import { ConfirmAccountDeletionDto } from "./dto/confirm-account-deletion.dto";
import { AccountDeletionResult } from "./entities/account-deletion-result.entity";

/**
 * Account erasure confirmation, without a session.
 *
 * The emailed link is the proof of identity, so the confirmation works from any
 * device; see AccountDeletionService for why better-auth's own delete-user route
 * is not used here.
 */
@ApiTags("Account")
@Controller("account")
export class AccountDeletionController {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Post("confirm-deletion")
  @AllowAnonymous()
  @HttpCode(200)
  @ThrottleWithConfig("short")
  @ApiOperation({
    summary: "Confirm account anonymization with the email link token",
  })
  @ApiResponse({
    status: 200,
    description: "Account anonymized and its sessions ended",
  })
  @ApiResponse({
    status: 404,
    description: "Invalid or already used confirmation link",
  })
  @ApiResponse({
    status: 410,
    description: "Expired link, or the account was already erased",
  })
  @ApiResponse({
    status: 503,
    description: "DELETION_PEPPER is not configured",
  })
  @ZodSerializerDto(AccountDeletionResult)
  async confirmDeletion(@Body() dto: ConfirmAccountDeletionDto) {
    const result = await this.accountDeletionService.confirmDeletion(dto.token);

    return {
      success: true as const,
      anonymizedAt: result.anonymizedAt,
      anonymizedListings: result.anonymizedListings,
      settledApplications: result.settledApplications,
      protectedPlacements: result.protectedPlacements,
      message: "Votre compte a été anonymisé.",
    };
  }
}
