import {
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { logError } from "../lib/log";
import { PrismaService } from "../prisma.service";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Liveness, and readiness for whoever holds the token.
   *
   * It used to answer with the uptime and the state of the database to anyone who
   * asked, which is what let a caller tell "the application is up but the database
   * is down" apart from a healthy one and aim its requests accordingly. The detail
   * moved behind `?deep=1`, which needs the token: a readiness probe belongs to
   * whoever runs the platform, not to the internet.
   */
  @Get()
  @AllowAnonymous()
  @ApiOperation({ summary: "Liveness probe, and readiness with ?deep=1" })
  @ApiResponse({ status: 200, description: "The process is answering" })
  @ApiResponse({
    status: 401,
    description: "Missing or wrong deep probe token",
  })
  @ApiResponse({ status: 503, description: "The database does not answer" })
  async check(@Query("deep") deep?: string, @Query("token") token?: string) {
    if (deep !== "1") {
      return { status: "ok" };
    }

    // The same answer for a wrong token and for an unconfigured one: whether a
    // deep probe exists here is not something to confirm to a caller either.
    if (!this.authorized(token)) {
      throw new UnauthorizedException();
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // The caller gets nothing but the status: a driver message can name the
      // host, the schema and the failing statement. The stack goes to this
      // process's console, never to the response, and `errorMessage` redacts a
      // connection string the driver may have quoted.
      logError("health.db_check_failed", error);
      throw new ServiceUnavailableException("Service unavailable");
    }

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "connected",
    };
  }

  private authorized(token: string | undefined): boolean {
    const expected = this.config.get<string>("health.deepToken");

    return Boolean(expected) && token === expected;
  }
}
