import "reflect-metadata";
import "dotenv/config";

import { ConfigService } from "@nestjs/config";

import { createApp } from "./app";
import { errorMessage } from "./lib/log";

async function bootstrap() {
  const app = await createApp();

  const port = app.get(ConfigService).get<number>("port", 3000);

  await app.listen(port, "0.0.0.0");

  console.log(`Server running at http://localhost:${port}`);

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.warn(
        `\nShutdown already in progress (received ${signal}), ignoring.`,
      );
      return;
    }

    isShuttingDown = true;
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

    try {
      await app.close();
      console.log("Graceful shutdown completed");
      process.exit(0);
    } catch (err) {
      console.error(`Error during graceful shutdown: ${errorMessage(err)}`);
      try {
        process.exit(1);
      } catch {
        process.kill(process.pid, "SIGKILL");
      }
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error("Failed to start server", errorMessage(error));
  process.exit(1);
});
