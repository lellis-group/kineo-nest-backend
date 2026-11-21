import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectDisk, StorageDisk } from "@nestjs/storage";
import { logError, logEvent } from "../lib/log";
import { PrismaService } from "../prisma.service";

/** An object younger than this may still be part of an in-flight upload. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

@Injectable()
export class FilesLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectDisk("files") private readonly disk: StorageDisk,
  ) {}

  /**
   * Drops the binary personal data on account erasure.
   *
   * The erasure itself anonymizes rows and keeps them for the grace period, but a
   * CV or a profile photo is not made anonymous by clearing a name: the object is
   * deleted here, immediately after the erasure transaction commits.
   */
  async eraseForUser(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) return;

    const files = await this.prisma.storedFile.findMany({
      where: {
        OR: [
          { uploaderId: profile.id },
          { profileId: profile.id },
          { listing: { practice: { ownerId: profile.id } } },
          { application: { applicantId: profile.id } },
        ],
      },
      select: { id: true, storageKey: true },
    });
    if (files.length === 0) return;

    await this.prisma.storedFile.deleteMany({
      where: { id: { in: files.map((file) => file.id) } },
    });
    await this.removeObjects(
      files.map((file) => file.storageKey),
      "erasure",
    );

    logEvent("files.erased_for_account", { count: files.length });
  }

  /**
   * Catches objects whose row disappeared through a database cascade.
   *
   * Profile, listing and application deletes cascade `StoredFile` rows, which
   * cannot call S3 on the way out. A daily sweep against the bucket is the one
   * place that has to know about every such path; the age guard keeps it from
   * racing an upload that has not committed its row yet.
   */
  @Cron("0 3 * * *")
  async sweepOrphanedObjects(): Promise<void> {
    const objects: { key: string; lastModified: Date }[] = [];
    for await (const entry of this.disk.listAll()) {
      objects.push({ key: entry.key, lastModified: entry.lastModified });
    }
    const referenced = new Set(
      (
        await this.prisma.storedFile.findMany({
          select: { storageKey: true },
        })
      ).map((row) => row.storageKey),
    );
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
    const orphans = objects
      .filter(
        (object) =>
          object.lastModified.getTime() < cutoff && !referenced.has(object.key),
      )
      .map((object) => object.key);

    if (orphans.length === 0) return;

    await this.removeObjects(orphans, "orphan-sweep");
    logEvent("files.orphans_swept", { count: orphans.length });
  }

  private async removeObjects(keys: string[], context: string): Promise<void> {
    await Promise.all(
      keys.map((key) =>
        this.disk.delete(key).catch((error: unknown) => {
          logError("files.object.remove_failed", error, { context, key });
        }),
      ),
    );
  }
}
