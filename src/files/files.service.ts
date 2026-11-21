import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  InjectDisk,
  StorageDisk,
  StorageFileNotFoundError,
  type StoredUpload,
} from "@nestjs/storage";
import { getOwnedProfileId } from "../common/profile-lookup";
import type { StoredFile } from "../generated/prisma/client";
import { logError } from "../lib/log";
import { PrismaService } from "../prisma.service";
import type { StoredFileDto } from "./entities/file.entity";
import { canReadFile } from "./file-access";
import { FileRules, type UploadKind } from "./validation/file-rules";

function toDto(file: StoredFile): StoredFileDto {
  return {
    id: file.id,
    kind: file.kind,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    position: file.position,
    url: `/files/${file.id}`,
    createdAt: file.createdAt.toISOString(),
  };
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectDisk("files") private readonly disk: StorageDisk,
    private readonly rules: FileRules,
  ) {}

  async uploadAvatar(
    userId: string,
    file: StoredUpload,
  ): Promise<StoredFileDto> {
    return this.replaceSingle(userId, "AVATAR", file);
  }

  async uploadProfileCv(
    userId: string,
    file: StoredUpload,
  ): Promise<StoredFileDto> {
    return this.replaceSingle(userId, "CV", file);
  }

  /**
   * Copies the caller's current profile CV into a snapshot for one application.
   *
   * `StorageDisk.copy()` keeps the binary inside the store and makes the
   * application's CV immutable: editing or deleting the profile copy never
   * rewrites what the practice owner was sent.
   */
  async attachCvToApplication(
    userId: string,
    applicationId: string,
  ): Promise<StoredFileDto> {
    let snapshotKey: string | undefined;

    try {
      const uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { applicantId: true },
      });
      if (!application) {
        throw new NotFoundException(`Application ${applicationId} not found`);
      }
      if (application.applicantId !== uploaderProfileId) {
        throw new ForbiddenException();
      }

      const source = await this.prisma.storedFile.findFirst({
        where: { kind: "CV", profileId: uploaderProfileId },
        orderBy: { createdAt: "desc" },
      });
      if (!source) {
        throw new NotFoundException("No CV found on your profile");
      }

      snapshotKey = `cv-applications/${applicationId}/${randomUUID()}${extname(source.storageKey)}`;
      await this.disk.copy(source.storageKey, snapshotKey);
      const storedKey = snapshotKey;

      const previous = await this.prisma.storedFile.findMany({
        where: { kind: "CV", applicationId },
        select: { storageKey: true },
      });

      const created = await this.prisma.$transaction(async (tx) => {
        await tx.storedFile.deleteMany({
          where: { kind: "CV", applicationId },
        });
        return tx.storedFile.create({
          data: {
            kind: "CV",
            storageKey: storedKey,
            originalName: source.originalName,
            mimeType: source.mimeType,
            size: source.size,
            position: 0,
            uploaderId: uploaderProfileId,
            applicationId,
          },
        });
      });

      await this.discard(
        previous.map((row) => row.storageKey),
        "application-cv-replace",
      );
      return toDto(created);
    } catch (error) {
      // The engine stores before the handler runs; nothing may be left behind.
      if (snapshotKey) {
        await this.discard([snapshotKey], "application-cv-rollback");
      }
      throw error;
    }
  }

  async uploadListingImages(
    userId: string,
    listingId: string,
    files: StoredUpload[],
  ): Promise<StoredFileDto[]> {
    const keys = files.map((file) => file.key);
    try {
      const uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
      const listing = await this.prisma.replacementListing.findUnique({
        where: { id: listingId },
        select: {
          createdById: true,
          practice: { select: { ownerId: true } },
        },
      });
      if (!listing) {
        throw new NotFoundException(
          `Replacement listing ${listingId} not found`,
        );
      }
      if (
        uploaderProfileId !== listing.createdById &&
        uploaderProfileId !== listing.practice.ownerId
      ) {
        throw new ForbiddenException();
      }

      const existing = await this.prisma.storedFile.count({
        where: { kind: "LISTING_IMAGE", listingId },
      });
      const prepared = files.map((file, index) => ({
        key: file.key,
        originalName: this.rules.displayName(file.originalname),
        mimeType: file.contentType,
        size: file.size,
        position: existing + index,
      }));

      const created = await this.prisma.storedFile.createManyAndReturn({
        data: prepared.map((item) => ({
          kind: "LISTING_IMAGE" as const,
          storageKey: item.key,
          originalName: item.originalName,
          mimeType: item.mimeType,
          size: item.size,
          position: item.position,
          uploaderId: uploaderProfileId,
          listingId,
        })),
      });
      return created.sort((a, b) => a.position - b.position).map(toDto);
    } catch (error) {
      await this.discard(keys, "listing-images-rollback");
      throw error;
    }
  }

  /**
   * Resolves the row and checks that its object still exists. `stat()` is used
   * rather than `get()`: `serveFile()` opens the stream itself, and an unread
   * stream here would leak a file handle.
   */
  async read(
    id: string,
    userId?: string,
  ): Promise<{ file: StoredFileDto; key: string }> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !(await canReadFile(this.prisma, file, userId))) {
      throw new NotFoundException(`File ${id} not found`);
    }

    try {
      await this.disk.stat(file.storageKey);
      return { file: toDto(file), key: file.storageKey };
    } catch (error) {
      if (!(error instanceof StorageFileNotFoundError)) {
        logError("files.open_failed", error, { id });
      }
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  /**
   * The CV an application carries, without exposing its file id.
   *
   * A practice owner knows the application, not the candidate's file ids, so
   * this is the read path the frontend uses on the received-applications side.
   */
  async readApplicationCv(
    applicationId: string,
    userId: string,
  ): Promise<{ file: StoredFileDto; key: string }> {
    const subject = {
      kind: "CV" as const,
      profileId: null,
      listingId: null,
      applicationId,
    };
    if (!(await canReadFile(this.prisma, subject, userId))) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }

    const file = await this.prisma.storedFile.findFirst({
      where: { kind: "CV", applicationId },
      orderBy: { createdAt: "desc" },
    });
    if (!file) {
      throw new NotFoundException(
        `No CV attached to application ${applicationId}`,
      );
    }

    try {
      await this.disk.stat(file.storageKey);
      return { file: toDto(file), key: file.storageKey };
    } catch (error) {
      if (!(error instanceof StorageFileNotFoundError)) {
        logError("files.open_failed", error, { applicationId });
      }
      throw new NotFoundException(
        `No CV attached to application ${applicationId}`,
      );
    }
  }

  async remove(id: string, userId: string): Promise<void> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) {
      throw new NotFoundException(`File ${id} not found`);
    }

    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile || file.uploaderId !== profile.id) {
      throw new NotFoundException(`File ${id} not found`);
    }

    await this.prisma.storedFile.delete({ where: { id } });
    await this.discard([file.storageKey], "file-delete");
  }

  async listForListing(listingId: string, userId?: string) {
    const allowed = await canReadFile(
      this.prisma,
      {
        kind: "LISTING_IMAGE",
        listingId,
        profileId: null,
        applicationId: null,
      },
      userId,
    );
    if (!allowed) {
      throw new NotFoundException(`Replacement listing ${listingId} not found`);
    }

    const files = await this.prisma.storedFile.findMany({
      where: { kind: "LISTING_IMAGE", listingId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return files.map(toDto);
  }

  async listMine(userId: string): Promise<StoredFileDto[]> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) return [];

    const files = await this.prisma.storedFile.findMany({
      where: { uploaderId: profile.id },
      orderBy: { createdAt: "desc" },
    });
    return files.map(toDto);
  }

  private async replaceSingle(
    userId: string,
    kind: "AVATAR" | "CV",
    file: StoredUpload,
  ): Promise<StoredFileDto> {
    let uploaderProfileId: string;
    let previous: string[];

    try {
      uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
      previous = (
        await this.prisma.storedFile.findMany({
          where: { kind, profileId: uploaderProfileId },
          select: { storageKey: true },
        })
      ).map((row) => row.storageKey);
    } catch (error) {
      await this.discard([file.key], "profile-file-precheck-rollback");
      throw error;
    }

    try {
      // The partial unique index forbids two avatars (or two reusable CVs) per
      // profile; delete and create share one transaction so the old row stays
      // if the insert fails.
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.storedFile.deleteMany({
          where: { kind, profileId: uploaderProfileId },
        });
        return tx.storedFile.create({
          data: {
            kind,
            storageKey: file.key,
            originalName: this.rules.displayName(file.originalname),
            mimeType: file.contentType,
            size: file.size,
            position: 0,
            uploaderId: uploaderProfileId,
            profileId: uploaderProfileId,
          },
        });
      });

      await this.discard(previous, "profile-file-replace");
      return toDto(created);
    } catch (error) {
      await this.discard([file.key], "profile-file-rollback");
      throw error;
    }
  }

  private async discard(keys: string[], context: string): Promise<void> {
    if (keys.length === 0) return;
    try {
      // StorageDisk.delete accepts several keys; missing ones are ignored.
      await this.disk.delete(keys);
    } catch (error) {
      // The rows are already gone; a leaked object is better than a failed
      // upload. It is logged so the cleanup sweep can find it later.
      logError("files.object.remove_failed", error, { context, keys });
    }
  }
}

// Kept for the specs, which build uploads by kind.
export type { UploadKind };
