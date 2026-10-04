import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { PrismaService } from "../../prisma.service";

/**
 * HTTP methods that mutate state. Everything else is a read and is not
 * guarded.
 *
 * This is what lets the guard sit at controller level rather than on each
 * individual write handler. It used to be declared on the four `POST` handlers
 * and nowhere else, so `PATCH /applications/:id/accept`, `PATCH
 * /replacement-listings/:id/close` and every `DELETE` ran with no check at all:
 * an unverified or erased account could accept a replacement, take a posting
 * out of circulation and delete a practice, while being refused on `POST
 * /profile`. Enumerating the protected handlers by hand is what let the two
 * halves drift apart in the first place — the method is the thing that actually
 * decides whether a request writes.
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
 *
 * The verification requirement itself is read from `REQUIRE_EMAIL_VERIFICATION`
 * rather than assumed. It used to be unconditional, which contradicted the
 * shipped default: better-auth only sends a verification email on sign-up when
 * that flag is on, so with the default configuration every write answered 403
 * and no verification email had ever been sent. `deletedAt` is checked before
 * the flag, so an anonymized account stays refused either way.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get requireEmailVerification(): boolean {
    return this.config.get<boolean>("requireEmailVerification", false) ?? false;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Reads are never gated: a candidate has to be able to see the status of
    // their own applications while their verification is still pending.
    if (!WRITE_METHODS.has(request?.method)) {
      return true;
    }

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

    if (!user || user.deletedAt) {
      throw new ForbiddenException(
        "Email must be verified to perform this action",
      );
    }

    if (this.requireEmailVerification && !user.emailVerified) {
      throw new ForbiddenException(
        "Email must be verified to perform this action",
      );
    }

    return true;
  }
}
