import type { Readable } from "node:stream";

/** The object returned when opening a stored file for streaming. */
export interface StoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

/**
 * The boundary between the file domain and the object store.
 *
 * Nothing outside this interface knows RustFS exists: the service deals in
 * storage keys and buffers, and tests substitute an in-memory implementation.
 */
export interface StoredObjectRef {
  key: string;
  lastModified: Date;
}

export interface FileStorage {
  save(key: string, body: Buffer, contentType: string): Promise<void>;
  open(key: string): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  list(): Promise<StoredObjectRef[]>;
}

export const FILE_STORAGE = Symbol("FILE_STORAGE");
