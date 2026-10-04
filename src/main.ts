import "reflect-metadata";
import "dotenv/config";

import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import compression from "compression";
import helmet from "helmet";
import { cleanupOpenApiDoc } from "nestjs-zod";

import { AppModule } from "./app.module";
import { errorMessage } from "./lib/log";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(compression());

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          scriptSrc: [`'self'`, `'unsafe-inline'`, "cdn.jsdelivr.net"],
          styleSrc: [
            `'self'`,
            `'unsafe-inline'`,
            "cdn.jsdelivr.net",
            "fonts.googleapis.com",
          ],
          imgSrc: [`'self'`, "data:", "cdn.jsdelivr.net"],
          fontSrc: [`'self'`, "fonts.gstatic.com", "cdn.jsdelivr.net", "data:"],
          connectSrc: [`'self'`, "api.scalar.com"],
        },
      },
    }),
  );

  const configService = app.get(ConfigService);

  if (configService.get<boolean>("trustProxy", false)) {
    app.set("trust proxy", 1);
  }

  const port = configService.get<number>("port", 3000);

  const corsOrigins = configService.get<string[]>("cors.origins", []);

  app.enableCors({
    origin: corsOrigins,
    credentials: configService.get<boolean>("cors.credentials", true),
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle(configService.get<string>("swagger.title", "Kineo API"))
    .setDescription(
      configService.get<string>(
        "swagger.description",
        "Kineo API documentation",
      ),
    )
    .setVersion(configService.get<string>("swagger.version", "1.0"))
    .addTag(configService.get<string>("swagger.tag", "Kineo"))
    .build();

  const documentFactory = () =>
    cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));

  SwaggerModule.setup("api", app, documentFactory);

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
      console.error("Error during graceful shutdown:", err);
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
