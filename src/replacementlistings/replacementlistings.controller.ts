import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { UserSession } from "@thallesp/nestjs-better-auth";
import {
  AllowAnonymous,
  OptionalAuth,
  Session,
} from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { ThrottleWithConfig } from "../common/decorators/throttle-with-config.decorator";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import type { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import { FindReplacementListingsDto } from "./dto/find-replacementlistings.dto";
import type { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
import {
  PaginatedReplacementListings,
  ReplacementListing,
} from "./entities/replacementlisting.entity";
import { ReplacementlistingsService } from "./replacementlistings.service";

@ApiTags("Replacement Listings")
@Controller("replacement-listings")
export class ReplacementlistingsController {
  constructor(
    private readonly replacementlistingsService: ReplacementlistingsService,
  ) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a draft replacement listing for a practice you own",
  })
  @ApiResponse({ status: 201, description: "Listing created as draft" })
  @ApiResponse({
    status: 403,
    description: "You do not own this practice or email not verified",
  })
  @ZodSerializerDto(ReplacementListing)
  create(
    @Session() session: UserSession,
    @Body() createReplacementlistingDto: CreateReplacementListingDto,
  ) {
    return this.replacementlistingsService.create(
      session.user.id,
      createReplacementlistingDto,
    );
  }

  @Get()
  @AllowAnonymous()
  @ApiOperation({ summary: "Search open replacement listings" })
  @ZodSerializerDto(PaginatedReplacementListings)
  findAll(@Query() query: FindReplacementListingsDto) {
    return this.replacementlistingsService.findAll(query);
  }

  @Get("mine")
  @ApiOperation({
    summary: "List all listings created by the current user, any status",
  })
  @ZodSerializerDto(PaginatedReplacementListings)
  findMine(
    @Session() session: UserSession,
    @Query() query: FindReplacementListingsDto,
  ) {
    return this.replacementlistingsService.findMine(session.user.id, query);
  }

  @Get(":id")
  @OptionalAuth()
  @ApiOperation({ summary: "Get a listing by id" })
  @ApiResponse({ status: 404, description: "Listing not found or not open" })
  @ZodSerializerDto(ReplacementListing)
  findOne(
    @Session() session: UserSession | undefined,
    @Param("id") id: string,
  ) {
    return this.replacementlistingsService.findOne(id, session?.user.id);
  }

  @Patch(":id/publish")
  @ApiOperation({
    summary: "Publish a draft listing, making it publicly visible",
  })
  @ApiResponse({ status: 400, description: "Listing is not a draft" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  publish(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.publish(id, session.user.id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a listing" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() updateReplacementlistingDto: UpdateReplacementListingDto,
  ) {
    return this.replacementlistingsService.update(
      id,
      session.user.id,
      updateReplacementlistingDto,
    );
  }

  @Delete(":id")
  @ZodSerializerDto(ReplacementListing)
  @ApiOperation({ summary: "Delete a listing" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.remove(id, session.user.id);
  }

  @Patch(":id/close")
  @ApiOperation({
    summary: "Close a listing once the replacement is completed",
  })
  @ApiResponse({ status: 400, description: "Listing is not open or filled" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  close(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.close(id, session.user.id);
  }

  @Patch(":id/cancel")
  @ApiOperation({ summary: "Cancel a listing before it is filled" })
  @ApiResponse({
    status: 400,
    description: "Listing is already closed or cancelled",
  })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  cancel(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.cancel(id, session.user.id);
  }
}
