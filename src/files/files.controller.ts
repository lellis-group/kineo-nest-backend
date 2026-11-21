import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  InjectDisk,
  StorageDisk,
  type StoredUpload,
  serveFile,
} from "@nestjs/storage";
import {
  ApiBearerAuth,
  ApiBody,
  type ApiBodyOptions,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  OptionalAuth,
  Session,
  type UserSession,
} from "@thallesp/nestjs-better-auth";
import type { Request, Response } from "express";
import { ZodSerializerDto } from "nestjs-zod";
import { ApiError } from "../common/api-errors";
import { EmailVerifiedGuard } from "../common/guards/email-verified.guard";
import { ThrottleWithConfig } from "../common/throttle";
import { StoredFileDto, StoredFileListDto } from "./entities/file.entity";
import { FilesService } from "./files.service";
import {
  AvatarFileInterceptor,
  ListingImagesInterceptor,
  ProfileCvFileInterceptor,
} from "./validation/file-interceptors";

/**
 * Swagger UI only renders a file picker for a body property declared with
 * `format: "binary"`. `@ApiConsumes` alone leaves `requestBody` empty, which is
 * why the upload routes looked unusable from the docs.
 */
const SINGLE_FILE_BODY: ApiBodyOptions = {
  schema: {
    type: "object",
    properties: { file: { type: "string", format: "binary" } },
    required: ["file"],
  },
};

const MULTIPLE_FILES_BODY: ApiBodyOptions = {
  schema: {
    type: "object",
    properties: {
      images: {
        type: "array",
        items: { type: "string", format: "binary" },
      },
    },
    required: ["images"],
  },
};

@ApiTags("Files")
@ApiBearerAuth()
@UseGuards(EmailVerifiedGuard)
@Controller("files")
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    @InjectDisk("files") private readonly disk: StorageDisk,
  ) {}

  @Post("avatar")
  @ThrottleWithConfig("medium")
  @UseInterceptors(AvatarFileInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody(SINGLE_FILE_BODY)
  @ApiOperation({ summary: "Upload or replace the caller's profile photo" })
  @ApiResponse({ status: 201, type: StoredFileDto })
  @ZodSerializerDto(StoredFileDto)
  uploadAvatar(
    @Session() session: UserSession,
    @UploadedFile() file: StoredUpload,
  ) {
    return this.filesService.uploadAvatar(session.user.id, file);
  }

  @Post("cv")
  @ThrottleWithConfig("medium")
  @UseInterceptors(ProfileCvFileInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody(SINGLE_FILE_BODY)
  @ApiOperation({ summary: "Upload or replace the caller's reusable CV" })
  @ApiResponse({ status: 201, type: StoredFileDto })
  @ZodSerializerDto(StoredFileDto)
  uploadProfileCv(
    @Session() session: UserSession,
    @UploadedFile() file: StoredUpload,
  ) {
    return this.filesService.uploadProfileCv(session.user.id, file);
  }

  @Post("listings/:listingId/images")
  @ThrottleWithConfig("medium")
  @UseInterceptors(ListingImagesInterceptor)
  @ApiConsumes("multipart/form-data")
  @ApiBody(MULTIPLE_FILES_BODY)
  @ApiOperation({ summary: "Add photos to a listing you own" })
  @ApiResponse({ status: 403, description: "Not the owner", type: ApiError })
  @ApiResponse({ status: 201, type: [StoredFileDto] })
  @ZodSerializerDto(StoredFileListDto)
  uploadListingImages(
    @Session() session: UserSession,
    @Param("listingId") listingId: string,
    @UploadedFiles() files: StoredUpload[],
  ) {
    return this.filesService.uploadListingImages(
      session.user.id,
      listingId,
      files,
    );
  }

  @Get("mine")
  @ApiOperation({ summary: "List the files uploaded by the caller" })
  @ApiResponse({ status: 200, type: [StoredFileDto] })
  @ZodSerializerDto(StoredFileListDto)
  listMine(@Session() session: UserSession) {
    return this.filesService.listMine(session.user.id);
  }

  @Get("listings/:listingId/images")
  // Public photos, but keep the session when the owner reads a closed listing.
  @OptionalAuth()
  @ApiOperation({ summary: "List the photos of a visible listing" })
  @ApiResponse({ status: 200, type: [StoredFileDto] })
  @ApiResponse({
    status: 404,
    description: "Listing not found",
    type: ApiError,
  })
  @ZodSerializerDto(StoredFileListDto)
  listListingImages(
    @Session() session: UserSession | undefined,
    @Param("listingId") listingId: string,
  ) {
    return this.filesService.listForListing(listingId, session?.user.id);
  }

  @Get(":id")
  // Avatars and listing photos follow the visibility of their owner; CVs stay
  // private through `canReadFile`, which denies a caller without a session.
  @OptionalAuth()
  @ApiOperation({ summary: "Stream a file the caller may read" })
  @ApiResponse({ status: 404, description: "File not found", type: ApiError })
  async download(
    @Session() session: UserSession | undefined,
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { file, key } = await this.filesService.read(id, session?.user.id);

    return serveFile(this.disk, key, {
      req,
      res,
      disposition: file.kind === "CV" ? "attachment" : "inline",
      filename: file.originalName,
    });
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a file the caller uploaded" })
  @ApiResponse({ status: 404, description: "File not found", type: ApiError })
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.filesService.remove(id, session.user.id);
  }
}
