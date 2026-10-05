import "reflect-metadata";

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
 * The application as it is served in production, minus the listen call.
 *
 * main.ts only listens; everything that shapes a response lives here, so the
 * e2e suites exercise the same helmet, compression, CORS, proxy and Swagger
 * configuration as a real request instead of a bare Nest application.
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

  app.enableCors({
    origin: configService.get<string[]>("cors.origins", []),
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

  if (!isHardenedEnv(configService.get<string>("nodeEnv"))) {
    const documentFactory = () =>
      cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
    SwaggerModule.setup("api", app, documentFactory);
  }

  return app;
}
