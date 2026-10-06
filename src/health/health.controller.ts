import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { logError } from "../lib/log";
import { PrismaService } from "../prisma.service";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @AllowAnonymous()
  @ApiOperation({ summary: "Health check endpoint" })
  @ApiResponse({ status: 200, description: "Service is healthy" })
  @ApiResponse({ status: 503, description: "Service is unhealthy" })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // Anonymous callers get nothing but the status: a driver message can name
      // the host, the schema and the failing statement. The stack goes to this
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
}
