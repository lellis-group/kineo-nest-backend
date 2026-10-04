import { describe, expect, it } from "bun:test";
import { ServiceUnavailableException } from "@nestjs/common";
import type { PrismaService } from "../prisma.service";
import { HealthController } from "./health.controller";

function makeController(error?: unknown) {
  const prisma = {
    $queryRaw: async () => {
      if (error) throw error;
      return 1;
    },
  } as unknown as PrismaService;

  return new HealthController(prisma);
}

describe("HealthController", () => {
  it("reports the database as connected", async () => {
    const result = await makeController().check();

    expect(result).toMatchObject({ status: "ok", database: "connected" });
    expect(result.uptime).toBeGreaterThan(0);
  });

  it("answers 503 without the driver message when the database is unreachable", async () => {
    const controller = makeController(
      new Error("connection to server at 10.0.0.7 port 5432 failed"),
    );

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await expect(controller.check()).rejects.toThrow("Service unavailable");
  });

  it("does not leak a non-Error rejection", async () => {
    const controller = makeController("secret connection string");

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
