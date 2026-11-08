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
import { ApiError } from "../common/api-errors";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
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
@UseGuards(EmailVerifiedGuard)
@Controller("profile")
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Post()
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a professional profile for the current user",
  })
  @ApiResponse({
    status: 403,
    description: "Email not verified",
    type: ApiError,
  })
  @ApiResponse({
    status: 409,
    description: "Profile already exists or RPPS number already in use",
    type: ApiError,
  })
  @ApiResponse({
    status: 201,
    description: "The profile, as created",
    type: Profile,
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
  @ApiResponse({
    status: 200,
    description: "A page of public profiles",
    type: PaginatedPublicProfiles,
  })
  @ZodSerializerDto(PaginatedPublicProfiles)
  findAll(@Query() query: FindProfilesDto) {
    return this.profileService.findAll(query);
  }

  @Get("me")
  @ApiOperation({ summary: "Get the current user's own profile" })
  @ApiResponse({
    status: 404,
    description: "No profile found for this user",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The caller's own profile",
    type: Profile,
  })
  @ZodSerializerDto(Profile)
  findMe(@Session() session: UserSession) {
    return this.profileService.findByUserId(session.user.id);
  }

  @Get(":id")
  @OptionalAuth()
  @ApiOperation({ summary: "Get a profile by id" })
  @ApiResponse({
    status: 404,
    description: "Profile not found or not public",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The profile, as visible to the caller",
    type: PublicProfile,
  })
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
    description: "Not the owner of this profile",
    type: ApiError,
  })
  @ApiResponse({
    status: 200,
    description: "The profile, as updated",
    type: Profile,
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
  @ApiResponse({
    status: 200,
    description: "The profile, as deleted",
    type: Profile,
  })
  @ZodSerializerDto(Profile)
  @ApiOperation({ summary: "Delete a profile" })
  @ApiResponse({
    status: 403,
    description: "Not the owner of this profile",
    type: ApiError,
  })
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.profileService.remove(id, session.user.id);
  }
}
