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
import {
  AllowAnonymous,
  OptionalAuth,
  Session,
} from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
import { MAX_BROWSE_MAP_PLACES } from "../replacementlistings/browse";
import type { CreateReplacementListingDto } from "./dto/create-replacementlisting.dto";
import {
  FindPageOfDto,
  FindPlacesDto,
  FindReplacementListingsDto,
} from "./dto/find-replacementlistings.dto";
import type { UpdateReplacementListingDto } from "./dto/update-replacementlisting.dto";
import {
  ListingFacets,
  ListingPageOf,
  ListingPlaces,
  PaginatedReplacementListings,
  ReplacementListing,
} from "./entities/replacementlisting.entity";
import { ReplacementlistingsService } from "./replacementlistings.service";

/**
 * What a public read of the feed may be cached for, by whoever holds it.
 *
 * The browse endpoints answer the same collection to every reader: the feed is
 * OPEN listings under public practices, with nothing scoped to a caller, which
 * is what makes the cacheability a property of the response rather than a
 * per-route decision. Before this, none of the three carried any header, so a
 * browser re-downloaded a 142 kB `/places` on every visit and the Next.js proxy
 * paid its own hop for it each time.
 *
 * The window is deliberately short. The collection changes the moment somebody
 * publishes or closes a posting, and a reader who is told 42 results for a
 * minute after there are 41 sees a count that is stale by one; a reader who is
 * told that for an hour sees a feed that is quietly lying. 60 s shared, 15 s
 * private, with a stale answer served while a fresh one is fetched behind it —
 * so the cost of a cold cache is paid once and not by the reader who caused it.
 */
const BROWSE_CACHE_CONTROL =
  "public, max-age=15, s-maxage=60, stale-while-revalidate=300";

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
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({ summary: "Search open replacement listings" })
  @ZodSerializerDto(PaginatedReplacementListings)
  findAll(@Query() query: FindReplacementListingsDto) {
    return this.replacementlistingsService.findAll(query);
  }

  // Declared before `:id` on purpose: Nest matches the routes in the order they
  // appear in the file, so a `facets` handler declared after `:id` would never be
  // reached — the `:id` route would answer to the literal string "facets" and
  // look for a listing with that id.
  @Get("facets")
  @AllowAnonymous()
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "Counts for the browse screen: total, urgent, and the distribution per specialty",
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
  @AllowAnonymous()
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "The places the browse map is drawn from, over the whole matching collection",
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
  @AllowAnonymous()
  @Header("Cache-Control", BROWSE_CACHE_CONTROL)
  @ApiOperation({
    summary:
      "Which page of the reader's ordering holds one posting, or null if the filters do not show it",
  })
  @ZodSerializerDto(ListingPageOf)
  findPageOf(@Query() query: FindPageOfDto) {
    return this.replacementlistingsService.findPageOf(query.id, query);
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
