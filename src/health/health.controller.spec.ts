import { describe, expect, it } from "bun:test";
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma.service";
import { HealthController } from "./health.controller";

function makeController(options: { error?: unknown; deepToken?: string } = {}) {
  const prisma = {
    $queryRaw: async () => {
      if (options.error) throw options.error;
      return 1;
    },
  } as unknown as PrismaService;
  const config = {
    get: <T>(key: string) =>
      (key === "health.deepToken" ? options.deepToken : undefined) as T,
  } as unknown as ConfigService;

  return new HealthController(prisma, config);
}

describe("HealthController", () => {
  it("answers liveness and nothing else", async () => {
    const result = await makeController().check();

    expect(result).toEqual({ status: "ok" });
  });

  it("refuses the deep probe without the token", async () => {
    const controller = makeController({ deepToken: "probe-token-value" });

    await expect(controller.check("1")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.check("1", "wrong")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuses the deep probe when no token is configured", async () => {
    await expect(
      makeController().check("1", "anything"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("reports the database state with the token", async () => {
    const result = await makeController({
      deepToken: "probe-token-value",
    }).check("1", "probe-token-value");

    expect(result).toMatchObject({ status: "ok", database: "connected" });
    expect(result.uptime).toBeGreaterThan(0);
  });

  it("answers 503 without the driver message when the database is unreachable", async () => {
    const controller = makeController({
      error: new Error("connection to server at 10.0.0.7 port 5432 failed"),
      deepToken: "probe-token-value",
    });

    await expect(
      controller.check("1", "probe-token-value"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    await expect(controller.check("1", "probe-token-value")).rejects.toThrow(
      "Service unavailable",
    );
  });

  it("does not leak a non-Error rejection", async () => {
    const controller = makeController({
      error: "secret connection string",
      deepToken: "probe-token-value",
    });

    await expect(
      controller.check("1", "probe-token-value"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
