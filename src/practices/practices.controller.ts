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
import { CreatePracticeDto } from "./dto/create-practice.dto";
import { FindPracticesDto } from "./dto/find-practices.dto";
import { UpdatePracticeDto } from "./dto/update-practice.dto";
import { PaginatedPractices, Practice } from "./entities/practice.entity";
import { PracticesService } from "./practices.service";

@ApiTags("Practices")
@Controller("practices")
export class PracticesController {
  constructor(private readonly practicesService: PracticesService) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @ThrottleWithConfig("medium")
  @ApiOperation({
    summary: "Create a practice owned by the current user's profile",
  })
  @ApiResponse({ status: 201, description: "Practice created" })
  @ApiResponse({ status: 403, description: "Email not verified" })
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
  @ZodSerializerDto(PaginatedPractices)
  findAll(@Query() query: FindPracticesDto) {
    return this.practicesService.findAll(query);
  }

  @Get("mine")
  @ApiOperation({
    summary: "List practices owned by the current user's profile",
  })
  @ZodSerializerDto([Practice])
  findMine(@Session() session: UserSession) {
    return this.practicesService.findMine(session.user.id);
  }

  @Get(":id")
  @OptionalAuth()
  @ApiOperation({ summary: "Get a practice by id" })
  @ApiResponse({ status: 404, description: "Practice not found or not public" })
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
  @ZodSerializerDto(Practice)
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() updatePracticeDto: UpdatePracticeDto,
  ) {
    return this.practicesService.update(id, session.user.id, updatePracticeDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a practice" })
  @ApiResponse({ status: 403, description: "Not the owner of this practice" })
  @ZodSerializerDto(Practice)
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.practicesService.remove(id, session.user.id);
  }
}
