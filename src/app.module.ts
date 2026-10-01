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

/**
 * Reads one throttle setting from the validated configuration.
 *
 * Each call site used to repeat its own fallback — `config.get("throttle.short.limit", 500)` —
 * so the same eight numbers were written down three times over: in
 * `configuration.ts`, in the Zod schema, and here. They could disagree, and
 * nothing would say so.
 *
 * Throwing rather than defaulting is deliberate. `configuration()` already
 * resolves every tier from `process.env` and rejects a non-positive value, so a
 * missing key here means the configuration object did not carry what this
 * factory was promised — a wiring bug, not a deployment choice. Silently
 * substituting a default would throttle the API by numbers nobody chose.
 */
function throttleValue(
  config: ConfigService,
  tier: "short" | "medium" | "long" | "deletion",
  field: "ttl" | "limit",
): number {
  const key = `throttle.${tier}.${field}`;
  const value = config.get<number>(key);

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`throttle configuration is incomplete: ${key} is missing`);
  }

  return value;
}

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
            ttl: throttleValue(config, "short", "ttl"),
            limit: throttleValue(config, "short", "limit"),
          },
          {
            name: "medium",
            ttl: throttleValue(config, "medium", "ttl"),
            limit: throttleValue(config, "medium", "limit"),
          },
          {
            name: "long",
            ttl: throttleValue(config, "long", "ttl"),
            limit: throttleValue(config, "long", "limit"),
          },
          {
            name: "deletion",
            ttl: throttleValue(config, "deletion", "ttl"),
            limit: throttleValue(config, "deletion", "limit"),
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
                // Fail towards SKIPPING this tier, not towards applying it.
                //
                // `skipIf` returning `false` means "do not skip", so the old
                // `catch { return false }` applied the 5-per-15-min budget to
                // every route of the whole API — including `/health` — the
                // moment `switchToHttp()` threw on a non-HTTP context. The
                // error would then be indistinguishable from a caller who had
                // genuinely hit the limit, and it would lock out reads rather
                // than protect the endpoint the tier exists for.
                //
                // Failing open here costs one erasure attempt on a context that
                // is not the erasure endpoint at all. Failing closed costs the
                // entire API. The right direction is not a close call.
                return true;
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
