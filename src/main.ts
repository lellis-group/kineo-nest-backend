import "reflect-metadata";
import "dotenv/config";

import { ConfigService } from "@nestjs/config";

import { createApp } from "./app";
import { errorMessage, logEvent } from "./lib/log";

async function bootstrap() {
  const app = await createApp();
  const config = app.get(ConfigService);
  const port = config.get<number>("port", 3000);

  if (config.get<boolean>("trustProxyImplied", false)) {
    // Nobody set TRUST_PROXY, so the application decided to trust a proxy. Behind
    // one that is right; exposed directly it makes `req.ip` — and the throttler
    // key derived from it — whatever the caller sent. One line at boot is what
    // makes that distinguishable from a deliberate choice.
    logEvent("config.trust_proxy_implied", {
      value: config.get<boolean>("trustProxy", false),
      nodeEnv: config.get<string>("nodeEnv"),
    });
  }

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
      console.error("Error during graceful shutdown:", errorMessage(err));
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void bootstrap().catch((error) => {
  console.error("Failed to start server", errorMessage(error));
  process.exit(1);
});
