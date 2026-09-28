import { describe, expect, it, mock } from "bun:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";

function controllerWithQuery(query: () => Promise<unknown>) {
  const prisma = { $queryRaw: mock(query) };
  return new HealthController(prisma as never);
}

describe("HealthController", () => {
  it("returns a minimal payload without internal details when healthy", async () => {
    const controller = controllerWithQuery(async () => [{ "1": 1 }]);

    const result = await controller.check();

    expect(result).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(result).not.toHaveProperty("database");
    expect(result).not.toHaveProperty("uptime");
  });

  it("raises 503 without exposing the driver error when the database is down", async () => {
    const controller = controllerWithQuery(async () => {
      throw new Error(
        'connect ECONNREFUSED 10.0.1.7:5432 for role "kineo" on database "mydb"',
      );
    });

    const error = await controller.check().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const response = (error as ServiceUnavailableException).getResponse();
    expect(JSON.stringify(response)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(response)).not.toContain("kineo");
  });
});
