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
// See `ProfileController`: class level, so `publish`, `close`, `cancel` and
// `DELETE /:id` are covered — `close` and `cancel` are the two that take a
// posting out of circulation and settle the candidates waiting on it.
@UseGuards(EmailVerifiedGuard)
@Controller("replacement-listings")
export class ReplacementlistingsController {
  constructor(
    private readonly replacementlistingsService: ReplacementlistingsService,
  ) {}

  @Post()
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
  @ApiOperation({ summary: "Delete a listing" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.remove(id, session.user.id);
  }

  @Patch(":id/close")
  @ApiOperation({
    summary:
      "Close a listing, distinguishing whether a replacement was retained",
    description:
      "From FILLED, the accepted application is kept and the listing is CLOSED. " +
      "From IN_DISCUSSION or FULL, nobody was retained: the applications are " +
      "settled and the listing becomes CLOSED_NO_CANDIDATE, which the applicant reads.",
  })
  @ApiResponse({
    status: 400,
    description: "Listing is a draft or already out of circulation",
  })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  close(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.close(id, session.user.id);
  }

  @Patch(":id/cancel")
  @ApiOperation({ summary: "Cancel a listing before it is filled" })
  @ApiResponse({
    status: 400,
    description:
      "Listing is filled (close it instead) or already out of circulation",
  })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ZodSerializerDto(ReplacementListing)
  cancel(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.cancel(id, session.user.id);
  }
}
