import { randomUUID } from "node:crypto";
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getOwnedProfileId } from "../common/profile-lookup";
import type { StoredFile } from "../generated/prisma/client";
import { logError } from "../lib/log";
import { PrismaService } from "../prisma.service";
import type { StoredFileDto } from "./entities/file.entity";
import { canReadFile } from "./file-access";
import {
  FILE_STORAGE,
  type FileStorage,
  type StoredObject,
} from "./storage/file-storage";
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

function discardFromStorage(
  storage: FileStorage,
  keys: string[],
  context: string,
): Promise<void> {
  return Promise.all(
    keys.map((key) =>
      storage.remove(key).catch((error: unknown) => {
        // The row is already gone; a leaked object is better than a failed
        // upload. It is logged so a cleanup sweep can find it later.
        logError("files.object.remove_failed", error, { context, key });
      }),
    ),
  ).then(() => undefined);
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly rules: FileRules,
  ) {}

  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
  ): Promise<StoredFileDto> {
    const uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
    const key = `avatars/${uploaderProfileId}/${randomUUID()}${this.rules.extensionFor(file.mimetype)}`;
    return this.replaceSingle(
      {
        kind: "AVATAR",
        uploaderId: uploaderProfileId,
        profileId: uploaderProfileId,
      },
      key,
      file,
    );
  }

  async uploadProfileCv(
    userId: string,
    file: Express.Multer.File,
  ): Promise<StoredFileDto> {
    const uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
    const key = `cv-profiles/${uploaderProfileId}/${randomUUID()}${this.rules.extensionFor(file.mimetype)}`;
    return this.replaceSingle(
      {
        kind: "CV",
        uploaderId: uploaderProfileId,
        profileId: uploaderProfileId,
      },
      key,
      file,
    );
  }

  /**
   * Copies the caller's current profile CV into a snapshot for one application.
   *
   * S3's CopyObject keeps the binary out of Node and makes the application's CV
   * immutable: editing or deleting the profile copy never rewrites what the
   * practice owner was sent.
   */
  async attachCvToApplication(
    userId: string,
    applicationId: string,
  ): Promise<StoredFileDto> {
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

    const key = `cv-applications/${applicationId}/${randomUUID()}${this.rules.extensionFor(source.mimeType)}`;
    await this.storage.copy(source.storageKey, key);

    const previous = await this.prisma.storedFile.findMany({
      where: { kind: "CV", applicationId },
      select: { storageKey: true },
    });

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.storedFile.deleteMany({
          where: { kind: "CV", applicationId },
        });
        return tx.storedFile.create({
          data: {
            kind: "CV",
            storageKey: key,
            originalName: source.originalName,
            mimeType: source.mimeType,
            size: source.size,
            position: 0,
            uploaderId: uploaderProfileId,
            applicationId,
          },
        });
      });

      await discardFromStorage(
        this.storage,
        previous.map((row) => row.storageKey),
        "application-cv-replace",
      );

      return toDto(created);
    } catch (error) {
      await discardFromStorage(this.storage, [key], "application-cv-rollback");
      throw error;
    }
  }

  async uploadListingImages(
    userId: string,
    listingId: string,
    files: Express.Multer.File[],
  ): Promise<StoredFileDto[]> {
    const uploaderProfileId = await getOwnedProfileId(this.prisma, userId);
    const listing = await this.prisma.replacementListing.findUnique({
      where: { id: listingId },
      select: {
        createdById: true,
        practice: { select: { ownerId: true } },
      },
    });
    if (!listing) {
      throw new NotFoundException(`Replacement listing ${listingId} not found`);
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
      key: `listings/${listingId}/${randomUUID()}${this.rules.extensionFor(file.mimetype)}`,
      originalName: this.rules.displayName(file.originalname),
      mimeType: file.mimetype,
      size: file.size,
      position: existing + index,
      file,
    }));

    await Promise.all(
      prepared.map((item) =>
        this.storage.save(item.key, item.file.buffer, item.mimeType),
      ),
    );

    try {
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
      await discardFromStorage(
        this.storage,
        prepared.map((item) => item.key),
        "listing-images-rollback",
      );
      throw error;
    }
  }

  async read(
    id: string,
    userId?: string,
  ): Promise<{ file: StoredFileDto; object: StoredObject }> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !(await canReadFile(this.prisma, file, userId))) {
      throw new NotFoundException(`File ${id} not found`);
    }

    try {
      const object = await this.storage.open(file.storageKey);
      return { file: toDto(file), object };
    } catch (error) {
      logError("files.open_failed", error, { id });
      throw new NotFoundException(`File ${id} not found`);
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
    await discardFromStorage(this.storage, [file.storageKey], "file-delete");
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
    scope: {
      kind: UploadKind;
      uploaderId: string;
      profileId: string;
    },
    key: string,
    file: Express.Multer.File,
  ): Promise<StoredFileDto> {
    await this.storage.save(key, file.buffer, file.mimetype);

    // The old row has to go before the new one is inserted: the partial unique
    // index forbids two avatars (or two reusable CVs) per profile. Doing both in
    // one transaction keeps the old row if the insert fails for any other reason.
    const previous = await this.prisma.storedFile.findMany({
      where: { kind: scope.kind, profileId: scope.profileId },
      select: { storageKey: true },
    });

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.storedFile.deleteMany({
          where: { kind: scope.kind, profileId: scope.profileId },
        });
        return tx.storedFile.create({
          data: {
            kind: scope.kind,
            storageKey: key,
            originalName: this.rules.displayName(file.originalname),
            mimeType: file.mimetype,
            size: file.size,
            position: 0,
            uploaderId: scope.uploaderId,
            profileId: scope.profileId,
          },
        });
      });

      await discardFromStorage(
        this.storage,
        previous.map((row) => row.storageKey),
        "profile-file-replace",
      );

      return toDto(created);
    } catch (error) {
      await discardFromStorage(this.storage, [key], "profile-file-rollback");
      throw error;
    }
  }
}
