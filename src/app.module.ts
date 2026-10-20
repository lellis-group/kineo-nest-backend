import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Reflector,
} from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AccountDeletionModule } from "./account-deletion/account-deletion.module";
import { AppController } from "./app.controller";
import { ApplicationsModule } from "./applications/applications.module";
import { HttpExceptionFilter } from "./common/filters/http-exception/http-exception.filter";
import { TokenAwareThrottlerGuard } from "./common/guards/token-aware-throttler.guard";
import { throttlerModuleOptions } from "./common/throttle";
import configuration, { envValidationSchema } from "./config/configuration";
import { DataLifecycleModule } from "./data-lifecycle/data-lifecycle.module";
import { HealthModule } from "./health/health.module";
import {
  type ConfigGetter,
  createAuth,
  readAuthEnvFromConfig,
} from "./lib/auth";
import { PracticesModule } from "./practices/practices.module";
import { PrismaModule } from "./prisma.module";
import { PrismaService } from "./prisma.service";
import { ProfileModule } from "./profile/profile.module";
import { ReplacementlistingsModule } from "./replacementlistings/replacementlistings.module";

/** The request body ceiling, shared by the JSON and the form parser. */
const BODY_LIMIT = "100kb";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, Reflector],
      useFactory: throttlerModuleOptions,
    }),
    AuthModule.forRootAsync({
      imports: [ConfigModule],
      // The PrismaService this application serves every other read and write
      // from goes to better-auth too. It builds its own PrismaClient if none is
      // handed it, so omitting the injection here meant three clients in one
      // process — the app's, the middleware this creates, and one more the
      // standalone factory below would hold in reserve — three pools against
      // the database's `max_connections`, grown N times by N replicas, and
      // three logging configurations where one is configured. One client: the
      // PrismaModule instance, exported globally.
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) => ({
        auth: createAuth(
          readAuthEnvFromConfig(config as unknown as ConfigGetter),
          prisma,
        ),
        // Nest's own body parser is off, so this module mounts the parsers. It
        // defaults to 100kb; stating it here makes the ceiling belong to the
        // repository rather than to the library's default.
        bodyParser: {
          json: { limit: BODY_LIMIT },
          urlencoded: { limit: BODY_LIMIT, extended: true },
        },
      }),
    }),
    AccountDeletionModule,
    ProfileModule,
    PracticesModule,
    ReplacementlistingsModule,
    ApplicationsModule,
    DataLifecycleModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_GUARD, useClass: TokenAwareThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
