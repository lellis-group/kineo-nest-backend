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
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
import { CreatePracticeDto } from "./dto/create-practice.dto";
import { FindPracticesDto } from "./dto/find-practices.dto";
import { UpdatePracticeDto } from "./dto/update-practice.dto";
import { PaginatedPractices, Practice } from "./entities/practice.entity";
import { PracticesService } from "./practices.service";

@ApiTags("Practices")
@UseGuards(EmailVerifiedGuard)
@Controller("practices")
export class PracticesController {
  constructor(private readonly practicesService: PracticesService) {}

  @Post()
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a practice owned by the current user's profile",
  })
  @ApiResponse({ status: 403, description: "Email not verified" })
  @ApiResponse({
    status: 201,
    description: "The practice, as created",
    type: Practice,
  })
  @ZodSerializerDto(Practice)
  create(
    @Session() session: UserSession,
    @Body() createPracticeDto: CreatePracticeDto,
  ) {
    return this.practicesService.create(session.user.id, createPracticeDto);
  }

  @Get()
  @AllowAnonymous()
  @ApiOperation({
    summary: "Search public practices, with optional geographic radius search",
  })
  @ApiResponse({
    status: 200,
    description: "A page of public practices",
    type: PaginatedPractices,
  })
  @ZodSerializerDto(PaginatedPractices)
  findAll(@Query() query: FindPracticesDto) {
    return this.practicesService.findAll(query);
  }

  @Get("mine")
  @ApiOperation({
    summary: "List practices owned by the current user's profile",
  })
  @ApiResponse({
    status: 200,
    description: "The practices owned by the caller",
    type: [Practice],
  })
  @ZodSerializerDto([Practice])
  findMine(@Session() session: UserSession) {
    return this.practicesService.findMine(session.user.id);
  }

  @Get(":id")
  @OptionalAuth()
  @ApiOperation({ summary: "Get a practice by id" })
  @ApiResponse({ status: 404, description: "Practice not found or not public" })
  @ApiResponse({
    status: 200,
    description: "The practice, as visible to the caller",
    type: Practice,
  })
  @ZodSerializerDto(Practice)
  findOne(
    @Session() session: UserSession | undefined,
    @Param("id") id: string,
  ) {
    return this.practicesService.findOne(id, session?.user.id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a practice" })
  @ApiResponse({ status: 403, description: "Not the owner of this practice" })
  @ApiResponse({
    status: 200,
    description: "The practice, as updated",
    type: Practice,
  })
  @ZodSerializerDto(Practice)
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() updatePracticeDto: UpdatePracticeDto,
  ) {
    return this.practicesService.update(id, session.user.id, updatePracticeDto);
  }

  @Delete(":id")
  @ApiResponse({
    status: 200,
    description: "The practice, as deleted",
    type: Practice,
  })
  @ZodSerializerDto(Practice)
  @ApiOperation({ summary: "Delete a practice" })
  @ApiResponse({ status: 403, description: "Not the owner of this practice" })
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.practicesService.remove(id, session.user.id);
  }
}
