import { Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module";
import { AccountDeletionController } from "./account-deletion.controller";
import { AccountDeletionService } from "./account-deletion.service";

@Module({
  imports: [FilesModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
})
export class AccountDeletionModule {}
