import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { UserSession } from "@thallesp/nestjs-better-auth";
import { Session } from "@thallesp/nestjs-better-auth";
import { ZodSerializerDto } from "nestjs-zod";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
import { ApplicationsService } from "./applications.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { FindApplicationsDto } from "./dto/find-applications.dto";
import { RejectApplicationDto } from "./dto/reject-application.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { WithdrawApplicationDto } from "./dto/withdraw-application.dto";
import {
  Application,
  PaginatedApplications,
} from "./entities/application.entity";

@ApiTags("Applications")
@UseGuards(EmailVerifiedGuard)
@Controller("applications")
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @ThrottleWithConfig("medium")
  @ApiOperation({ summary: "Apply to a replacement listing" })
  @ApiResponse({ status: 409, description: "Already applied to this listing" })
  @ApiResponse({
    status: 201,
    description: "The application, as submitted",
    type: Application,
  })
  @ZodSerializerDto(Application)
  create(
    @Session() session: UserSession,
    @Body() createApplicationDto: CreateApplicationDto,
  ) {
    return this.applicationsService.create(
      session.user.id,
      createApplicationDto,
    );
  }

  @Get("mine")
  @ApiOperation({ summary: "List the current user's own applications" })
  @ApiResponse({
    status: 200,
    description: "A page of the caller's applications",
    type: PaginatedApplications,
  })
  @ZodSerializerDto(PaginatedApplications)
  findMine(
    @Session() session: UserSession,
    @Query() query: FindApplicationsDto,
  ) {
    return this.applicationsService.findMine(session.user.id, query);
  }

  @Get("listing/:listingId")
  @ApiOperation({ summary: "List applications received for a listing you own" })
  @ApiResponse({ status: 403, description: "Not the owner of this listing" })
  @ApiResponse({
    status: 200,
    description: "A page of applications received for the listing",
    type: PaginatedApplications,
  })
  @ZodSerializerDto(PaginatedApplications)
  findForListing(
    @Session() session: UserSession,
    @Param("listingId") listingId: string,
    @Query() query: FindApplicationsDto,
  ) {
    return this.applicationsService.findForListing(
      listingId,
      session.user.id,
      query,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an application by id" })
  @ApiResponse({
    status: 404,
    description: "Application not found or no access",
  })
  @ApiResponse({
    status: 200,
    description: "The application, as visible to the caller",
    type: Application,
  })
  @ZodSerializerDto(Application)
  findOne(@Session() session: UserSession, @Param("id") id: string) {
    return this.applicationsService.findOne(id, session.user.id);
  }

  @Patch(":id/view")
  @ApiOperation({ summary: "Mark an application as viewed" })
  @ApiResponse({ status: 403, description: "Not the owner of the listing" })
  @ApiResponse({
    status: 200,
    description: "The application, now marked as viewed",
    type: Application,
  })
  @ZodSerializerDto(Application)
  markAsViewed(@Session() session: UserSession, @Param("id") id: string) {
    return this.applicationsService.markAsViewed(id, session.user.id);
  }

  @Patch(":id/shortlist")
  @ApiOperation({ summary: "Shortlist a pending application" })
  @ApiResponse({ status: 400, description: "Application is not pending" })
  @ApiResponse({
    status: 200,
    description: "The application, now shortlisted",
    type: Application,
  })
  @ZodSerializerDto(Application)
  shortlist(@Session() session: UserSession, @Param("id") id: string) {
    return this.applicationsService.shortlist(id, session.user.id);
  }

  @Patch(":id/accept")
  @ApiOperation({
    summary:
      "Accept an application, filling the listing and rejecting other candidates",
  })
  @ApiResponse({
    status: 400,
    description: "Application cannot be accepted in its current status",
  })
  @ApiResponse({
    status: 200,
    description: "The application, now accepted",
    type: Application,
  })
  @ZodSerializerDto(Application)
  accept(@Session() session: UserSession, @Param("id") id: string) {
    return this.applicationsService.accept(id, session.user.id);
  }

  @Patch(":id/reject")
  @ApiOperation({ summary: "Reject an application" })
  @ApiResponse({
    status: 400,
    description: "Application cannot be rejected in its current status",
  })
  @ApiResponse({
    status: 200,
    description: "The application, now rejected",
    type: Application,
  })
  @ZodSerializerDto(Application)
  reject(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() dto: RejectApplicationDto,
  ) {
    return this.applicationsService.reject(id, session.user.id, dto);
  }

  @Patch(":id/withdraw")
  @ApiOperation({ summary: "Withdraw your own application" })
  @ApiResponse({
    status: 400,
    description: "Application cannot be withdrawn in its current status",
  })
  @ApiResponse({
    status: 200,
    description: "The application, now withdrawn",
    type: Application,
  })
  @ZodSerializerDto(Application)
  withdraw(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() dto: WithdrawApplicationDto,
  ) {
    return this.applicationsService.withdraw(id, session.user.id, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit the message of a pending application" })
  @ApiResponse({
    status: 400,
    description: "Only pending applications can be edited",
  })
  @ApiResponse({
    status: 200,
    description: "The application, with its edited message",
    type: Application,
  })
  @ZodSerializerDto(Application)
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body() updateApplicationDto: UpdateApplicationDto,
  ) {
    return this.applicationsService.update(
      id,
      session.user.id,
      updateApplicationDto,
    );
  }
}
