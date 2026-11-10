import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { UserSession } from "@thallesp/nestjs-better-auth";
import { Session } from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { ApiBadRequest, ApiError } from "../common/api-errors";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
import { MAX_BROWSE_MAP_PLACES } from "../replacementlistings/browse";
import { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import {
  FindPageOfDto,
  FindPlacesDto,
  FindReplacementListingsDto,
} from "./dto/find-replacementlistings.dto";
import { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
import {
  ListingFacets,
  ListingPageOf,
  ListingPlaces,
  PaginatedReplacementListings,
  ReplacementListing,
} from "./entities/replacementlisting.entity";
import { ReplacementlistingsService } from "./replacementlistings.service";

/**
 * How long a browser may keep a read of the feed.
 *
 * The browse endpoints require a session, so the answer is `private`: a shared
 * cache (CDN, corporate proxy) must never store it and hand it to a reader who
 * has none. The content is the same for every member — OPEN listings under
 * public practices, nothing scoped to a caller — so the reader's own browser may
 * reuse it briefly, which is what spares a 142 kB `/places` on every visit.
 *
 * The window is deliberately short. The collection changes the moment somebody
 * publishes or closes a posting, and a count that is stale for fifteen seconds
 * is one a reader will not notice; stale for an hour, the feed is quietly lying.
 */
const BROWSE_CACHE_CONTROL = "private, max-age=15, stale-while-revalidate=60";

@ApiTags("Replacement Listings")
@UseGuards(EmailVerifiedGuard)
@Controller("replacement-listings")
export class ReplacementlistingsController {
  constructor(
    private readonly replacementlistingsService: ReplacementlistingsService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a draft replacement listing for a practice you own",
  })
  @ApiResponse({
    status: 403,
    description: "You do not own this practice or email not verified",
    type: ApiError,
  })
  @ApiResponse({
    status: 201,
    description: "The draft listing, as created",
    type: ReplacementListing,
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
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({ summary: "Search open replacement listings" })
  @ApiResponse({
    status: 200,
    description: "A page of open listings, with its pagination metadata",
    type: PaginatedReplacementListings,
  })
  @ZodSerializerDto(PaginatedReplacementListings)
  findAll(@Query() query: FindReplacementListingsDto) {
    return this.replacementlistingsService.findAll(query);
  }

  // Declared before `:id` on purpose: Nest matches the routes in the order they
  // appear in the file, so a `facets` handler declared after `:id` would never be
  // reached — the `:id` route would answer to the literal string "facets" and
  // look for a listing with that id.
  @Get("facets")
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "Counts for the browse screen: total, urgent, and the distribution per specialty",
  })
  @ApiResponse({
    status: 200,
    description: "The counts the browse screen filters by",
    type: ListingFacets,
  })
  @ZodSerializerDto(ListingFacets)
  findFacets(@Query() query: FindReplacementListingsDto) {
    return this.replacementlistingsService.findFacets(query);
  }

  // Declared before `:id`, like `facets` above: Nest matches routes in the order
  // they appear, so a handler declared after `:id` would never be reached — the
  // `:id` route would answer to the literal string "places" and look for a
  // listing with that id.
  @Get("places")
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "The places the browse map is drawn from, over the whole matching collection",
  })
  @ApiResponse({
    status: 200,
    description: "The places the map is drawn from",
    type: ListingPlaces,
  })
  @ZodSerializerDto(ListingPlaces)
  findPlaces(@Query() query: FindPlacesDto) {
    return this.replacementlistingsService.findPlaces(
      query,
      this.config.get<number>("browse.mapPlaces") ?? MAX_BROWSE_MAP_PLACES,
    );
  }

  // Declared before `:id`, like `facets` and `places` above: Nest matches routes
  // in the order they appear in the file, so a handler declared after `:id`
  // would never be reached.
  @Get("page-of")
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "Which page of the reader's ordering holds one posting, or null if the filters do not show it",
  })
  @ApiResponse({
    status: 200,
    description:
      "The page holding the posting, or null when the filters do not show it",
    type: ListingPageOf,
  })
  @ZodSerializerDto(ListingPageOf)
  findPageOf(@Query() query: FindPageOfDto) {
    return this.replacementlistingsService.findPageOf(query.id, query);
  }

  @Get("mine")
  @ApiOperation({
    summary: "List all listings created by the current user, any status",
  })
  @ApiResponse({
    status: 200,
    description: "A page of the caller's own listings, any status",
    type: PaginatedReplacementListings,
  })
  @ZodSerializerDto(PaginatedReplacementListings)
  findMine(
    @Session() session: UserSession,
    @Query() query: FindReplacementListingsDto,
  ) {
    return this.replacementlistingsService.findMine(session.user.id, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a listing by id" })
  @ApiResponse({
    status: 404,
    description: "Listing not found or not open",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The listing, as visible to the caller",
    type: ReplacementListing,
  })
  @ZodSerializerDto(ReplacementListing)
  findOne(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.findOne(id, session.user.id);
  }

  @Patch(":id/publish")
  @ApiOperation({
    summary: "Publish a draft listing, making it publicly visible",
  })
  @ApiBadRequest("Listing is not a draft")
  @ApiResponse({
    status: 403,
    description: "Not the owner of this listing",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The listing, now open",
    type: ReplacementListing,
  })
  @ZodSerializerDto(ReplacementListing)
  publish(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.publish(id, session.user.id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a listing" })
  @ApiResponse({
    status: 403,
    description: "Not the owner of this listing",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The listing, as updated",
    type: ReplacementListing,
  })
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
  @ApiResponse({
    status: 200,
    description: "The listing, as deleted",
    type: ReplacementListing,
  })
  @ZodSerializerDto(ReplacementListing)
  @ApiOperation({ summary: "Delete a listing" })
  @ApiResponse({
    status: 403,
    description: "Not the owner of this listing",
    type: ApiError,
  })
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.remove(id, session.user.id);
  }

  @Patch(":id/close")
  @ApiOperation({
    summary: "Close a listing once the replacement is completed",
  })
  @ApiBadRequest("Listing is not open or filled")
  @ApiResponse({
    status: 403,
    description: "Not the owner of this listing",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The listing, now closed",
    type: ReplacementListing,
  })
  @ZodSerializerDto(ReplacementListing)
  close(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.close(id, session.user.id);
  }

  @Patch(":id/cancel")
  @ApiOperation({ summary: "Cancel a listing before it is filled" })
  @ApiBadRequest("Listing is already closed or cancelled")
  @ApiResponse({
    status: 403,
    description: "Not the owner of this listing",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The listing, now cancelled",
    type: ReplacementListing,
  })
  @ZodSerializerDto(ReplacementListing)
  cancel(@Session() session: UserSession, @Param("id") id: string) {
    return this.replacementlistingsService.cancel(id, session.user.id);
  }
}
