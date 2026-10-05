import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma.service";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

    // Reads are never gated: a candidate has to see the status of their own
    // applications while their verification is still pending.
    if (!WRITE_METHODS.has(request?.method)) {
      return true;
    }

    const userId = request.session?.user?.id;

    if (!userId) {
      throw new ForbiddenException(
        "Email must be verified to perform this action",
      );
    }

    // The row, not the session: better-auth may serve the session from its
    // cookie cache, and the account erasure is exactly where that snapshot lies —
    // anonymization clears emailVerified while the cookie still says true.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, deletedAt: true },
    });

    // Checked before the flag, so an anonymized or purged account is refused
    // either way: with the flag off, its emailVerified says nothing.
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
