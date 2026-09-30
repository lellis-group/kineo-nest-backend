import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Observable } from "rxjs";

import { PrismaService } from "../../prisma.service";

/**
 * Requires a verified email on writes.
 *
 * The flag is re-read from the database rather than taken from the session
 * payload. `request.session.user` is a snapshot better-auth may have served
 * from the cookie cache, and the account erasure is exactly the case where
 * that snapshot lies: anonymization sets `emailVerified = false` in the row
 * while the cookie still says `true`. Trusting the session there meant an
 * erased identity could keep writing for the length of the cache window.
 *
 * `deletedAt` is checked alongside it so a purged or anonymized account is
 * refused even if a session cookie outlives its rows.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = request.session;
    const userId = session?.user?.id;

    if (!userId) {
      throw new ForbiddenException(
        "Email must be verified to perform this action",
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, deletedAt: true },
    });

    if (!user || user.deletedAt || !user.emailVerified) {
      throw new ForbiddenException(
        "Email must be verified to perform this action",
      );
    }

    return true;
  }
}
