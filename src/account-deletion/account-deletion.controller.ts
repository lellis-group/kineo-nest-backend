import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { ThrottleWithConfig } from "../common/decorators/throttle-with-config.decorator";
import { AccountDeletionService } from "./account-deletion.service";
import { ConfirmAccountDeletionDto } from "./dto/confirm-account-deletion.dto";
import { AccountDeletionResult } from "./entities/account-deletion-result.entity";

/**
 * Confirmation de suppression de compte SANS session.
 *
 * Better-auth `POST /api/auth/delete-user { token }` exige un cookie de
 * session valide au moment du clic sur le lien email : navigateur différent,
 * session expirée ou cookies bloqués → 404 « lien invalide » alors que le
 * token est valide. Ici, le lien email suffit : le jeton single-use
 * `delete-account-*` (24 h) est la preuve d'identité (RGPD art. 17).
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
  @ThrottleWithConfig("deletion")
  @ApiOperation({
    summary: "Confirm account deletion with the email link token (no session)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Account anonymized, access revoked, data purged after the grace period",
  })
  @ApiResponse({
    status: 404,
    description: "Invalid or already used confirmation link",
  })
  @ApiResponse({
    status: 409,
    description:
      "Listings still hold applications from other candidates (pending, shortlisted, or accepted)",
  })
  @ApiResponse({
    status: 410,
    description: "Expired link or already anonymized account",
  })
  @ZodSerializerDto(AccountDeletionResult)
  async confirmDeletion(@Body() dto: ConfirmAccountDeletionDto) {
    await this.accountDeletionService.confirmDeletion(dto.token);

    return { success: true as const, message: "Account deleted" as const };
  }
}
