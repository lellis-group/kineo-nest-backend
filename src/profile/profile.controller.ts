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
import { CreateProfileDto } from "./dto/create-profile.dto";
import { FindProfilesDto } from "./dto/find-profiles.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import {
  PaginatedPublicProfiles,
  Profile,
  PublicProfile,
} from "./entities/profile.entity";
import { ProfileService } from "./profile.service";

@ApiTags("Profile")
// Every write in this controller, not just `POST`. The guard reads the HTTP
// method and lets reads through, so class level is both complete and shorter
// than annotating each handler — and it cannot go stale when a route is added.
@UseGuards(EmailVerifiedGuard)
@Controller("profile")
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Post()
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a professional profile for the current user",
  })
  @ApiResponse({ status: 201, description: "Profile created" })
  @ApiResponse({ status: 403, description: "Email not verified" })
  @ApiResponse({
    status: 409,
    description: "Profile already exists or RPPS number already in use",
  })
  @ZodSerializerDto(Profile)
  create(
    @Session() session: UserSession,
    @Body() createProfileDto: CreateProfileDto,
  ) {
    return this.profileService.create(session.user.id, createProfileDto);
  }

  @Get()
  @AllowAnonymous()
  @ApiOperation({ summary: "Search public profiles" })
  @ZodSerializerDto(PaginatedPublicProfiles)
  findAll(@Query() query: FindProfilesDto) {
    return this.profileService.findAll(query);
  }

  @Get("me")
  @ApiOperation({ summary: "Get the current user's own profile" })
  @ApiResponse({ status: 404, description: "No profile found for this user" })
  @ZodSerializerDto(Profile)
  findMe(@Session() session: UserSession) {
    return this.profileService.findByUserId(session.user.id);
  }

  @Get(":id")
  @OptionalAuth()
  @ApiOperation({ summary: "Get a profile by id" })
  @ApiResponse({ status: 404, description: "Profile not found or not public" })
  @ZodSerializerDto(PublicProfile)
  findOne(
    @Session() session: UserSession | undefined,
    @Param("id") id: string,
  ) {
    return this.profileService.findOne(id, session?.user.id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a profile" })
  @ApiResponse({
    status: 403,
    description: "Not the owner of this profile, or the email is not verified",
  })
  @ZodSerializerDto(Profile)
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    return this.profileService.update(id, session.user.id, updateProfileDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a profile" })
  @ApiResponse({
    status: 403,
    description: "Not the owner of this profile, or the email is not verified",
  })
  @ZodSerializerDto(Profile)
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.profileService.remove(id, session.user.id);
  }
}
