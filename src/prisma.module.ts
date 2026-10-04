import { Global, Module } from "@nestjs/common";
import { SystemScaffoldService } from "./common/system-scaffold.service";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService, SystemScaffoldService],
  exports: [PrismaService, SystemScaffoldService],
})
export class PrismaModule {}
