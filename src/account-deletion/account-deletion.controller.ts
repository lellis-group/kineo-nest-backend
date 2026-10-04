import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Response } from "express";
import { ZodSerializerDto } from "nestjs-zod";
import { ThrottleWithConfig } from "../common/decorators/throttle-with-config.decorator";
import { AccountDeletionService } from "./account-deletion.service";
import { ConfirmAccountDeletionDto } from "./dto/confirm-account-deletion.dto";
import { AccountDeletionResult } from "./entities/account-deletion-result.entity";

/**
 * Session cookies this endpoint has to expire.
 *
 * `revokeAccess` deletes the `Session` rows, but that is invisible to the
 * browser: `session_token` is a signed cookie that still verifies
 * cryptographically, and better-auth only consults the database once the
 * session cannot be resolved from the cookie. Leaving it in place means the
 * erased account keeps a usable session — the erasure's central claim is that
 * access ends immediately.
 *
 * Names are listed rather than derived because the `__Secure-` prefix depends
 * on the runtime environment (`useSecureCookies`). Clearing a cookie that was
 * never set is a no-op, so both variants are always cleared.
 */
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "better-auth.session_data",
  "better-auth.account_data",
  "better-auth.dont_remember",
  "__Secure-better-auth.session_token",
  "__Secure-better-auth.session_data",
  "__Secure-better-auth.account_data",
  "__Secure-better-auth.dont_remember",
];

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
      "No pending erasure request matches this confirmation (code NO_PENDING_REQUEST)",
  })
  @ApiResponse({
    status: 410,
    description: "Expired link or already anonymized account",
  })
  @ZodSerializerDto(AccountDeletionResult)
  async confirmDeletion(
    @Body() dto: ConfirmAccountDeletionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.accountDeletionService.confirmDeletion(dto.token);

    // The person who clicked this link is the person holding the session, so
    // this is the one place the erasure can actually reach the browser's copy
    // of the credentials. `passthrough` keeps the serialized body intact.
    for (const name of SESSION_COOKIE_NAMES) {
      response.clearCookie(name, { path: "/" });
    }

    return { success: true as const, message: "Account deleted" as const };
  }
}
