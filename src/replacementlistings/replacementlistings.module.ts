import { Module } from "@nestjs/common";
import {
  BrowsePlacesCacheInterceptor,
  PlacesResponseCacheService,
} from "../common/browse-places-cache";
import { ReplacementlistingsController } from "./replacementlistings.controller";
import { ReplacementlistingsService } from "./replacementlistings.service";

@Module({
  controllers: [ReplacementlistingsController],
  providers: [
    ReplacementlistingsService,
    PlacesResponseCacheService,
    BrowsePlacesCacheInterceptor,
  ],
})
export class ReplacementlistingsModule {}
