import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { ProtectedLocalStorageDriver } from "../storage/local-driver"
import DigitalDownloadsModuleService from "../service"
import {
  DigitalStorageProvider,
  DigitalUploadPurpose,
  DigitalUploadStatus,
} from "../types"
import { resolveDigitalDownloadsOptions } from "../utils"

const TOKEN_SECRET = "upload-filename-token-secret".repeat(2)
const ENCRYPTION_KEY = "b".repeat(64)

describe("upload object filename bounding", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "digital-upload-name-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    ["255-character ASCII", `${"a".repeat(251)}.pdf`],
    ["255-character multibyte", `${"é".repeat(251)}.pdf`],
  ])("stores a %s original name through a local PUT", async (_label, filename) => {
    expect(filename).toHaveLength(255)
    const body = Buffer.from("bounded local upload")
    const driver = new ProtectedLocalStorageDriver({ rootPath: root })
    const uploads = new Map<string, Record<string, any>>()
    const service = Object.create(DigitalDownloadsModuleService.prototype) as any
    service.baseRepository_ = { getFreshManager: jest.fn().mockReturnValue({}) }
    service.options_ = resolveDigitalDownloadsOptions(
      {
        tokenSecret: TOKEN_SECRET,
        encryptionKey: ENCRYPTION_KEY,
        maxUploadSizeBytes: 1_024,
        storage: { local: { rootPath: root } },
      },
      {},
    )
    service.getSettings = jest.fn().mockResolvedValue({
      enabled: true,
      max_upload_size_bytes: 1_024,
    })
    service.storage_ = {
      driver: jest.fn().mockReturnValue(driver),
      putStream: jest.fn((input) => driver.putStream!(input)),
    }
    service.createDigitalUploads = jest.fn(async (input) => {
      const upload = { id: `dupl_${uploads.size + 1}`, ...input }
      uploads.set(upload.id, upload)
      return upload
    })
    service.retrieveDigitalUpload = jest.fn(async (id) => uploads.get(id))
    service.updateDigitalUploads = jest.fn(async (input) => {
      const current = uploads.get(input.id)!
      const updated = { ...current, ...input }
      uploads.set(input.id, updated)
      return updated
    })

    const intent = await service.initiateDigitalAssetUpload({
      filename,
      size: body.byteLength,
      mime_type: "application/pdf",
      storage_provider: DigitalStorageProvider.LOCAL,
      purpose: DigitalUploadPurpose.DOWNLOAD,
    })
    const upload = uploads.get(intent.id)!
    const leaf = path.posix.basename(String(upload.storage_key))

    expect(upload.original_filename).toBe(filename)
    expect(Buffer.byteLength(leaf, "utf8")).toBeLessThanOrEqual(255)
    expect(leaf).toMatch(/\.pdf$/)
    expect(upload.status).toBe(DigitalUploadStatus.PENDING)

    await expect(
      service.receiveDigitalAssetUpload(intent.id, {
        stream: Readable.from([body]),
        content_length: body.byteLength,
        content_type: "application/pdf",
        upload_token: intent.headers["x-digital-upload-token"],
      }),
    ).resolves.toMatchObject({
      id: intent.id,
      status: DigitalUploadStatus.UPLOADED,
      size: body.byteLength,
    })
    await expect(readFile(path.join(root, upload.storage_key))).resolves.toEqual(
      body,
    )
  })
})
