import { Global, Module } from "@nestjs/common";
import { SystemScaffoldService } from "./common/system-scaffold.service";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  // `SystemScaffoldService` re-creates the rows an erasure parks applications on,
  // so a deployment that ran `migrate deploy` alone is not missing them.
  providers: [PrismaService, SystemScaffoldService],
  exports: [PrismaService, SystemScaffoldService],
})
export class PrismaModule {}
