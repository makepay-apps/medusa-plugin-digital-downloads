import { createReadStream, promises as fs } from "node:fs"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { CONTENT_SECURITY_HEADERS } from "./constants.js"
import { apiError, notFound } from "./errors.js"
import {
  clientContext,
  getBearerGrantToken,
  privacyHash,
} from "./security.js"
import {
  hasServiceMethod,
  invokeService,
  resolveDigitalDownloadsService,
  unwrapResult,
} from "./service.js"
import { MimeTypeSchema, SafeFilenameSchema, parseId } from "./validators.js"

export type ByteRange = {
  start: number
  end: number
  length: number
  contentRange: string
}

export function validateSingleRangeSyntax(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined
  if (header.length > 200 || header.includes(",")) {
    throw apiError(416, "invalid_range", "Only one byte range is supported.")
  }
  if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(header)) {
    throw apiError(416, "invalid_range", "Invalid byte range.")
  }
  return header
}

export function parseSingleRange(
  header: string | undefined,
  totalSize: number,
): ByteRange | undefined {
  if (!header) return undefined
  validateSingleRangeSyntax(header)
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw apiError(502, "invalid_asset_size", "Asset size is unavailable.")
  }
  if (totalSize === 0) {
    throw apiError(416, "range_not_satisfiable", "Range is not satisfiable.", {
      total_size: 0,
    })
  }

  const value = header.slice("bytes=".length)
  let start: number
  let end: number
  if (value.startsWith("-")) {
    const suffix = Number(value.slice(1))
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw apiError(416, "invalid_range", "Invalid suffix byte range.")
    }
    start = Math.max(0, totalSize - suffix)
    end = totalSize - 1
  } else {
    const [startText, endText] = value.split("-", 2)
    start = Number(startText)
    end = endText ? Number(endText) : totalSize - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      throw apiError(416, "range_not_satisfiable", "Range is not satisfiable.", {
        total_size: totalSize,
      })
    }
    end = Math.min(end, totalSize - 1)
  }

  return {
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  }
}

export function resolveLocalAssetPath(root: string, storageKey: string): string {
  if (!root || !storageKey || isAbsolute(storageKey) || storageKey.includes("\0")) {
    throw apiError(500, "unsafe_storage_path", "Unsafe local storage path.")
  }
  const rootPath = resolve(root)
  const candidate = resolve(rootPath, storageKey)
  const traversal = relative(rootPath, candidate)
  if (traversal === ".." || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
    throw apiError(500, "unsafe_storage_path", "Unsafe local storage path.")
  }
  return candidate
}

async function secureLocalStream(
  root: string,
  storageKey: string,
  range?: ByteRange,
): Promise<{ body: Readable; totalSize: number }> {
  const requestedRoot = resolve(root)
  const requestedFile = resolveLocalAssetPath(requestedRoot, storageKey)
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(requestedRoot),
    fs.realpath(requestedFile),
  ])
  const traversal = relative(realRoot, realFile)
  if (traversal === ".." || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
    throw apiError(500, "unsafe_storage_path", "Unsafe local storage path.")
  }
  const stats = await fs.stat(realFile)
  if (!stats.isFile()) throw notFound("Asset content was not found.")
  return {
    body: createReadStream(realFile, range && { start: range.start, end: range.end }),
    totalSize: stats.size,
  }
}

type OpenedContent = {
  body: Readable
  totalSize: number
  contentLength: number
  mimeType: string
  filename: string
  action: "download" | "stream" | "preview"
  etag?: string
  lastModified?: string
  sourceStatus?: number
  sourceContentRange?: string
  eventId?: string
}

function numberField(source: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = source[name]
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value
    }
  }
  return undefined
}

function stringField(source: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = source[name]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

function readableBody(value: unknown): Readable | undefined {
  if (!value) return undefined
  if (value instanceof Readable) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Readable.from(Buffer.from(value))
  }
  const candidate = value as {
    pipe?: unknown
    transformToWebStream?: () => ReadableStream<Uint8Array>
  }
  if (typeof candidate.pipe === "function") return candidate as unknown as Readable
  if (typeof candidate.transformToWebStream === "function") {
    return Readable.fromWeb(
      candidate.transformToWebStream() as unknown as import("node:stream/web").ReadableStream,
    )
  }
  return undefined
}

async function normalizeOpenedContent(
  value: unknown,
  range: ByteRange | undefined,
  fallback: { filename?: string; mimeType?: string; action: OpenedContent["action"] },
): Promise<OpenedContent> {
  const unwrapped = unwrapResult(value, ["content", "asset_content", "result"])
  const source =
    unwrapped && typeof unwrapped === "object"
      ? (unwrapped as Record<string, unknown>)
      : {}
  const rawBody =
    source.body ?? source.stream ?? source.buffer ?? source.data ?? unwrapped
  let body = readableBody(rawBody)
  let totalSize = numberField(source, [
    "total_size",
    "totalSize",
    "asset_size",
    "size",
    "content_length",
    "contentLength",
  ])

  if (!body && typeof source.storage_root === "string" && typeof source.storage_key === "string") {
    const local = await secureLocalStream(source.storage_root, source.storage_key, range)
    body = local.body
    totalSize ??= local.totalSize
  }
  if (!body) {
    throw apiError(502, "content_unavailable", "Asset content is unavailable.")
  }
  if (totalSize === undefined) {
    throw apiError(502, "invalid_asset_size", "Asset size is unavailable.")
  }

  const filenameCandidate =
    fallback.filename ??
    stringField(source, ["filename", "display_name", "name"]) ??
    "download"
  const mimeCandidate =
    fallback.mimeType ??
    stringField(source, ["mime_type", "mimeType", "content_type", "contentType"]) ??
    "application/octet-stream"
  const filename = SafeFilenameSchema.safeParse(basename(filenameCandidate))
  const mimeType = MimeTypeSchema.safeParse(mimeCandidate)
  const contentLength =
    range?.length ??
    numberField(source, ["content_length", "contentLength"]) ??
    totalSize

  return {
    body,
    totalSize,
    contentLength,
    filename: filename.success ? filename.data : "download",
    mimeType: mimeType.success ? mimeType.data : "application/octet-stream",
    action: fallback.action,
    etag: stringField(source, ["etag"]),
    lastModified: stringField(source, ["last_modified", "lastModified"]),
    sourceStatus: numberField(source, ["status_code", "statusCode", "status"]),
    sourceContentRange: stringField(source, ["content_range", "contentRange"]),
    eventId: stringField(source, ["event_id", "download_event_id"]),
  }
}

function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180)
  return `${inline ? "inline" : "attachment"}; filename="${ascii || "download"}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function setContentHeaders(
  res: MedusaResponse,
  content: OpenedContent,
  range: ByteRange | undefined,
  isPublicPreview: boolean,
) {
  res.set(CONTENT_SECURITY_HEADERS)
  if (isPublicPreview) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, must-revalidate, no-transform",
    )
  }
  res.setHeader("Accept-Ranges", "bytes")
  res.setHeader("Content-Type", content.mimeType)
  res.setHeader("Content-Length", String(range?.length ?? content.contentLength))
  res.setHeader(
    "Content-Disposition",
    contentDisposition(
      content.filename,
      content.action === "stream" || content.action === "preview",
    ),
  )
  if (content.etag && !/[\r\n]/.test(content.etag)) {
    res.setHeader("ETag", content.etag.slice(0, 256))
  }
  if (content.lastModified) {
    const parsed = new Date(content.lastModified)
    if (!Number.isNaN(parsed.valueOf())) {
      res.setHeader("Last-Modified", parsed.toUTCString())
    }
  }
  if (range) {
    res.status(206)
    res.setHeader("Content-Range", range.contentRange)
  } else {
    res.status(200)
  }
}

function assertGetOnly(req: MedusaRequest, res: MedusaResponse): void {
  if (req.method === "GET") return
  res.setHeader("Allow", "GET")
  throw apiError(405, "method_not_allowed", "Only GET is supported.")
}

async function completeTransfer(
  service: Record<string, unknown>,
  eventId: string | undefined,
  result: "completed" | "failed",
  bytes: number,
  failureReason = "delivery_preflight_failed",
): Promise<boolean> {
  if (!eventId) return false
  const methods =
    result === "completed"
      ? ["completeDownloadEvent", "completeDownloadGrant", "markDownloadCompleted"]
      : ["failDownloadEvent", "failDownloadGrant", "markDownloadFailed"]
  if (!hasServiceMethod(service, methods)) return false
  await invokeService(
    service,
    methods,
    eventId,
    result === "completed"
      ? { bytes_transferred: bytes }
      : { reason: failureReason, bytes_transferred: bytes },
  )
  return true
}

async function commitTransferAccounting(
  service: Record<string, unknown>,
  eventId: string,
): Promise<boolean> {
  const methods = ["commitDownloadEvent", "commitDownloadGrantUse"]
  if (!hasServiceMethod(service, methods)) return false
  await invokeService(service, methods, eventId)
  return true
}

function exactByteCounter(
  expectedBytes: number,
  onBytes: (bytes: number) => void,
): Transform {
  let transferred = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (transferred + bytes.length > expectedBytes) {
        callback(new Error("Storage returned more bytes than authorized."))
        return
      }
      transferred += bytes.length
      onBytes(transferred)
      callback(null, bytes)
    },
    flush(callback) {
      if (transferred !== expectedBytes) {
        callback(new Error("Storage returned fewer bytes than authorized."))
        return
      }
      callback()
    },
  })
}

export async function streamGrantedContent(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  assertGetOnly(req, res)
  const service = resolveDigitalDownloadsService(req)
  const assetId = parseId(req.params.asset_id)
  const token = getBearerGrantToken(req)
  const rangeHeader = validateSingleRangeSyntax(req.get("range"))
  const authorization = await invokeService<Record<string, unknown>>(
    service,
    ["redeemDownloadGrant", "authorizeDownloadGrant", "consumeDownloadGrant"],
    token,
    {
      asset_id: assetId,
      range_header: rangeHeader,
      ...clientContext(req),
    },
  )
  const authorizationGrant =
    authorization.grant && typeof authorization.grant === "object"
      ? (authorization.grant as Record<string, unknown>)
      : authorization
  const transferEventId = stringField(authorization, [
    "event_id",
    "download_event_id",
  ])
  const authorizationAsset =
    authorization.asset && typeof authorization.asset === "object"
      ? (authorization.asset as Record<string, unknown>)
      : authorization
  const authorizedAssetId =
    stringField(authorizationAsset, ["id", "asset_id", "assetId"]) ??
    stringField(authorizationGrant, ["asset_id", "assetId"])
  const grantMetadata =
    authorizationGrant.metadata && typeof authorizationGrant.metadata === "object"
      ? (authorizationGrant.metadata as Record<string, unknown>)
      : {}
  const action =
    stringField(grantMetadata, ["action"]) === "stream"
      ? "stream"
      : "download"

  let content: OpenedContent
  let range: ByteRange | undefined
  try {
    if (authorizedAssetId && authorizedAssetId !== assetId) throw notFound()
    const totalSize = numberField(authorizationAsset, [
      "total_size",
      "totalSize",
      "asset_size",
      "size_bytes",
      "size",
    ])
    range = rangeHeader
      ? parseSingleRange(rangeHeader, totalSize ?? -1)
      : undefined
    let opened: unknown = authorization
    if (
      hasServiceMethod(service, [
        "openDigitalAsset",
        "openAssetStream",
        "streamDigitalAsset",
        "readDigitalAsset",
      ])
    ) {
      opened = await invokeService(
        service,
        [
          "openDigitalAsset",
          "openAssetStream",
          "streamDigitalAsset",
          "readDigitalAsset",
        ],
        assetId,
        {
          purpose: "delivery",
          action,
          grant_id: stringField(authorizationGrant, ["id", "grant_id"]),
          start: range?.start,
          end: range?.end,
          range,
          grant: authorization,
        },
      )
    }

    content = await normalizeOpenedContent(opened, range, {
      filename: stringField(authorizationAsset, [
        "filename",
        "original_filename",
        "display_name",
        "name",
      ]),
      mimeType: stringField(authorizationAsset, ["mime_type", "mimeType"]),
      action,
    })
    if (
      range &&
      (content.sourceStatus !== 206 ||
        content.sourceContentRange !== range.contentRange)
    ) {
      content.body.destroy()
      throw apiError(
        502,
        "range_not_honored",
        "The storage provider did not honor the byte range.",
      )
    }
  } catch (error) {
    await completeTransfer(
      service,
      transferEventId,
      "failed",
      0,
    ).catch(() => undefined)
    throw error
  }
  const eventId = transferEventId ?? content.eventId
  if (!eventId) {
    content.body.destroy()
    throw apiError(
      502,
      "transfer_accounting_unavailable",
      "Transfer accounting is unavailable.",
    )
  }
  let bytesTransferred = 0
  try {
    const accountingCommitted = await commitTransferAccounting(service, eventId)
    if (!accountingCommitted) {
      throw apiError(
        502,
        "transfer_accounting_unavailable",
        "Transfer accounting is unavailable.",
      )
    }
    setContentHeaders(res, content, range, false)
    const expectedBytes = range?.length ?? content.contentLength
    await pipeline(
      content.body,
      exactByteCounter(
        expectedBytes,
        (bytes) => {
          bytesTransferred = bytes
        },
      ),
      res,
    )
    const finalized = await completeTransfer(
      service,
      eventId,
      "completed",
      bytesTransferred,
    )
    if (!finalized) {
      throw apiError(
        502,
        "transfer_accounting_unavailable",
        "Transfer accounting is unavailable.",
      )
    }
  } catch (error) {
    if (!content.body.destroyed) content.body.destroy()
    await completeTransfer(
      service,
      eventId,
      "failed",
      bytesTransferred,
      "delivery_stream_failed",
    ).catch(() => undefined)
    throw error
  }
}

export async function streamPublicPreview(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  assertGetOnly(req, res)
  const service = resolveDigitalDownloadsService(req)
  const assetId = parseId(req.params.asset_id)
  const rangeHeader = validateSingleRangeSyntax(req.get("range"))
  const context = {
    asset_id: assetId,
    range_header: rangeHeader,
    ip_hash: privacyHash(req.ip),
    request_id: req.requestId,
  }
  const asset = await invokeService<Record<string, unknown>>(
    service,
    ["retrieveDigitalAsset"],
    assetId,
  )
  const totalSize = numberField(asset, [
    "total_size",
    "totalSize",
    "size_bytes",
    "size",
  ])
  const range = rangeHeader
    ? parseSingleRange(rangeHeader, totalSize ?? -1)
    : undefined
  const preview = await invokeService<Record<string, unknown>>(
    service,
    ["openDigitalAsset"],
    assetId,
    {
      purpose: "preview",
      start: range?.start,
      end: range?.end,
      range,
      ...context,
    },
  )

  let opened: unknown = preview
  if (
    !readableBody(preview.body ?? preview.stream ?? preview.buffer) &&
    hasServiceMethod(service, ["openDigitalAsset", "openAssetStream"])
  ) {
    opened = await invokeService(
      service,
      ["openDigitalAsset", "openAssetStream"],
      assetId,
      {
        purpose: "preview",
        start: range?.start,
        end: range?.end,
        range,
        authorization: preview,
      },
    )
  }
  const content = await normalizeOpenedContent(opened, range, {
    filename:
      stringField(preview, ["filename", "display_name"]) ??
      stringField(asset, ["original_filename", "name"]),
    mimeType:
      stringField(preview, ["mime_type", "mimeType"]) ??
      stringField(asset, ["mime_type", "mimeType"]),
    action: "preview",
  })
  if (
    range &&
    (content.sourceStatus !== 206 ||
      content.sourceContentRange !== range.contentRange)
  ) {
    content.body.destroy()
    throw apiError(
      502,
      "range_not_honored",
      "The storage provider did not honor the byte range.",
    )
  }
  setContentHeaders(res, content, range, true)
  await pipeline(content.body, res)
}
