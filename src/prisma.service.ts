import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { prismaClientOptions, prismaLogFor } from "./lib/prisma";

function resolveAdapter(config?: ConfigService) {
  const fromConfig = config?.get<string>("databaseUrl");
  // The logging switch comes from the validated configuration when there is one,
  // rather than from the options frozen when `lib/prisma` was first imported:
  // reading it at startup is what makes it a setting of the application instead
  // of an accident of module order.
  const logQueries = config?.get<boolean>("prismaLogQueries");
  const log =
    typeof logQueries === "boolean"
      ? prismaLogFor(logQueries)
      : prismaClientOptions.log;

  return typeof fromConfig === "string" && fromConfig.trim()
    ? {
        ...prismaClientOptions,
        adapter: new PrismaPg({ connectionString: fromConfig.trim() }),
        log,
      }
    : { ...prismaClientOptions, log };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Optional()
    @Inject(ConfigService)
    config?: ConfigService,
  ) {
    super(resolveAdapter(config));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
