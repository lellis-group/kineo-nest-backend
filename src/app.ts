import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import compression from "compression";
import helmet from "helmet";
import { cleanupOpenApiDoc } from "nestjs-zod";

import { AppModule } from "./app.module";
import { isHardenedEnv } from "./config/env";

/**
 * Builds the application with the middleware and configuration the server runs
 * with in production.
 *
 * Its own module rather than exported from `main.ts`, because `main.ts` calls
 * `bootstrap()` at load time and the e2e suites import this — importing `main`
 * would start a second listener.
 *
 * They used to build a bare `createNestApplication()` instead, which skipped
 * everything configured here: helmet, compression, CORS, `trust proxy` and the
 * Swagger gate. A regression in any of them merged green, and a suite that
 * claimed to test production was testing a different application.
 *
 * `init()` is deliberately not called: the suites listen on port 0 themselves so
 * they cannot collide with a development server.
 */
export async function createApp(): Promise<NestExpressApplication> {
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

  if (!isHardenedEnv(configService.get<string>("nodeEnv"))) {
    SwaggerModule.setup("api", app, documentFactory);
  }

  return app;
}
