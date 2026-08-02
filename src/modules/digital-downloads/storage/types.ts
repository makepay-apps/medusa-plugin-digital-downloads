import type { Readable } from "node:stream"

import type { DigitalStorageProvider } from "../types"

export interface StorageObjectLocator {
  key: string
  bucket?: string | null
}

export interface StoragePutInput extends StorageObjectLocator {
  body: Buffer | Uint8Array
  contentType: string
  checksumSha256?: string
  overwrite?: boolean
}

export interface StoragePutStreamInput extends StorageObjectLocator {
  body: Readable
  contentType: string
  expectedSize: number
  checksumSha256?: string
  overwrite?: boolean
}

export interface StorageReadInput extends StorageObjectLocator {
  start?: number
  end?: number
}

export interface StorageObjectResult {
  /**
   * A single-consumer stream. Callers must consume or destroy it so the
   * provider can release its file descriptor/socket.
   */
  body: Readable
  size: number
  totalSize: number
  contentType: string
  etag: string
  lastModified?: Date
  statusCode: 200 | 206
  contentRange?: string
}

export interface ProtectedStorageDescriptor {
  provider: DigitalStorageProvider
  url: string
  expiresAt: Date
}

export interface StorageObjectMetadata {
  size: number
  contentType: string
  checksumSha256?: string
  etag?: string
  lastModified?: Date
}

export interface StorageUploadDescriptor {
  method: "PUT"
  url: string
  headers: Record<string, string>
  expiresAt: Date
}

export interface StorageDriver {
  readonly provider: DigitalStorageProvider
  put(input: StoragePutInput): Promise<{
    key: string
    size: number
    checksumSha256: string
    etag: string
  }>
  putStream?(input: StoragePutStreamInput): Promise<{
    key: string
    size: number
    checksumSha256: string
    etag: string
  }>
  get(input: StorageReadInput): Promise<StorageObjectResult>
  delete(locator: StorageObjectLocator): Promise<void>
  exists(locator: StorageObjectLocator): Promise<boolean>
  inspect?(locator: StorageObjectLocator): Promise<StorageObjectMetadata>
  computeChecksum?(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }>
  createUploadDescriptor?(
    locator: StorageObjectLocator,
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ): Promise<StorageUploadDescriptor>
  createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor>
  destroy?(): void
}
