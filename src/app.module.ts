import type { ExecutionContext } from "@nestjs/common";
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
import { ThrottlerBehindProxyGuard } from "./common/guards/throttler-behind-proxy.guard";
import {
  DELETION_THROTTLE_KEY,
  THROTTLE_NAMES,
  type ThrottleName,
} from "./common/throttle";
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
import { ProfileModule } from "./profile/profile.module";
import { ReplacementlistingsModule } from "./replacementlistings/replacementlistings.module";

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
      useFactory: (config: ConfigService, reflector: Reflector) => ({
        // No fallback literals here: configuration() is the only place the
        // limits are declared, and the numbers it used to repeat were a second
        // source that could drift from it.
        throttlers: [
          ...THROTTLE_NAMES.map((name) => ({
            name,
            ttl: config.getOrThrow<number>(`throttle.${name}.ttl`),
            limit: config.getOrThrow<number>(`throttle.${name}.limit`),
          })),
          {
            name: "deletion" as ThrottleName,
            ttl: config.getOrThrow<number>("throttle.deletion.ttl"),
            limit: config.getOrThrow<number>("throttle.deletion.limit"),
            // Applied only where a route opted in with ThrottleDeletion:
            // registering it unconditionally would extend its budget to every
            // endpoint in the API.
            skipIf: (context: ExecutionContext) =>
              reflector.getAllAndOverride(DELETION_THROTTLE_KEY, [
                context.getHandler(),
                context.getClass(),
              ]) !== true,
          },
        ],
      }),
    }),
    AuthModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        auth: createAuth(
          readAuthEnvFromConfig(config as unknown as ConfigGetter),
        ),
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
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
