import type { ExecutionContext } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AccountDeletionModule } from "./account-deletion/account-deletion.module";
import { AppController } from "./app.controller";
import { ApplicationsModule } from "./applications/applications.module";
import { HttpExceptionFilter } from "./common/filters/http-exception/http-exception.filter";
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
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: "short",
            ttl: config.get<number>("throttle.short.ttl", 1000),
            limit: config.get<number>("throttle.short.limit", 500),
          },
          {
            name: "medium",
            ttl: config.get<number>("throttle.medium.ttl", 10000),
            limit: config.get<number>("throttle.medium.limit", 1500),
          },
          {
            name: "long",
            ttl: config.get<number>("throttle.long.ttl", 60000),
            limit: config.get<number>("throttle.long.limit", 3500),
          },
          {
            name: "deletion",
            ttl: config.get<number>("throttle.deletion.ttl", 900000),
            limit: config.get<number>("throttle.deletion.limit", 5),
            // The deletion tier (5 attempts / 15 min) protects the anonymous
            // account-erasure endpoint only. Without this, the global guard
            // would apply it to every undecorated route (GET /profile, health,
            // /api/auth/*, ...) and lock them after 5 hits.
            skipIf: (context: ExecutionContext) => {
              const handler = context.getHandler?.()?.name;
              const className = context.getClass?.()?.name;
              if (
                className === "AccountDeletionController" &&
                handler === "confirmDeletion"
              ) {
                return false;
              }
              try {
                const req = context.switchToHttp().getRequest();
                const url: unknown = req?.url ?? req?.originalUrl;
                if (
                  req?.method === "POST" &&
                  typeof url === "string" &&
                  url.includes("confirm-deletion")
                ) {
                  return false;
                }
              } catch {
                return false;
              }
              return true;
            },
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
    // The stock guard. Its `getTracker` returns `req.ip`, which Express resolves
    // through the `trust proxy` setting — the one source of truth for "who is
    // this request from". A subclass that read `req.ips[0]` looked like it
    // handled the proxy case better, but `req.ips` is the same filtered chain
    // `req.ip` is derived from, so it resolved to the identical value and only
    // added a `req.ips` dereference that would throw on a non-Express adapter.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
