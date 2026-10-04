import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { prismaClientOptions } from "./lib/prisma";

function resolveAdapter(config?: ConfigService) {
  // Pre-DI contexts (seed, standalone better-auth): fall back to process.env.
  // Inside Nest, prefer the validated ConfigService value when available.
  const fromConfig = config?.get<string>("databaseUrl");
  if (typeof fromConfig === "string" && fromConfig.trim()) {
    return { adapter: new PrismaPg({ connectionString: fromConfig.trim() }) };
  }
  return prismaClientOptions;
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
