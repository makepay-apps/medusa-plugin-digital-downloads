import type {
  MedusaErrorHandlerFunction,
  MedusaResponse,
} from "@medusajs/framework/http"
import { errorHandler as medusaErrorHandler } from "@medusajs/framework/http"

import { PRIVATE_NO_STORE_HEADERS } from "./constants.js"

const defaultMedusaErrorHandler = medusaErrorHandler()

export function isDigitalDownloadsApiPath(path: string | undefined): boolean {
  return /^\/(?:admin|store)\/digital-downloads(?:\/|$)/.test(path ?? "")
}

export class DigitalDownloadsApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "DigitalDownloadsApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DigitalDownloadsApiError {
  return new DigitalDownloadsApiError(status, code, message, details)
}

export function notFound(message = "Resource not found.") {
  return apiError(404, "not_found", message)
}

export function unauthorized(message = "Authentication is required.") {
  return apiError(401, "unauthorized", message)
}

export function forbidden(message = "Access is not allowed.") {
  return apiError(403, "forbidden", message)
}

export function conflict(message: string) {
  return apiError(409, "conflict", message)
}

export function unprocessable(message: string) {
  return apiError(422, "invalid_request", message)
}

export function serviceUnavailable() {
  return apiError(
    503,
    "digital_downloads_unavailable",
    "Digital Downloads is not configured. Add the plugin and run Medusa migrations.",
  )
}

function safeStatus(error: unknown): number {
  if (error instanceof DigitalDownloadsApiError) return error.status

  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    httpStatus?: unknown
    type?: unknown
    code?: unknown
  }
  const explicit = Number(
    candidate?.status ?? candidate?.statusCode ?? candidate?.httpStatus,
  )
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) {
    return explicit
  }

  const marker = String(candidate?.type ?? candidate?.code ?? "").toLowerCase()
  if (marker.includes("not_found") || marker === "404") return 404
  if (marker.includes("not_allowed") || marker.includes("forbidden")) return 403
  if (marker.includes("unauthorized")) return 401
  if (marker.includes("conflict") || marker.includes("duplicate")) return 409
  if (marker.includes("invalid") || marker.includes("validation")) return 400
  return 500
}

function safeCode(error: unknown, status: number): string {
  if (error instanceof DigitalDownloadsApiError) return error.code
  const candidate = error as { code?: unknown; type?: unknown }
  const code = candidate?.code ?? candidate?.type
  if (
    typeof code === "string" &&
    /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(code)
  ) {
    return code.toLowerCase()
  }
  return status === 500 ? "internal_error" : "request_failed"
}

function safeMessage(error: unknown, status: number): string {
  if (error instanceof DigitalDownloadsApiError) return error.message
  if (status >= 500) return "The request could not be completed."
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" && message.length <= 500
    ? message
    : "The request could not be completed."
}

function safeDetails(
  error: unknown,
  status: number,
): Record<string, unknown> | undefined {
  if (error instanceof DigitalDownloadsApiError) return error.details
  if (status !== 416) return undefined

  const totalSize = (error as { details?: { total_size?: unknown } })?.details
    ?.total_size
  if (
    typeof totalSize !== "number" ||
    !Number.isSafeInteger(totalSize) ||
    totalSize < 0
  ) {
    return undefined
  }
  return { total_size: totalSize }
}

export function sendApiError(res: MedusaResponse, error: unknown): void {
  const status = safeStatus(error)
  const code = safeCode(error, status)
  const message = safeMessage(error, status)
  const requestId = (res.req as { requestId?: string } | undefined)?.requestId
  const details = safeDetails(error, status)

  if (
    status === 416 &&
    typeof details?.total_size === "number" &&
    Number.isSafeInteger(details.total_size)
  ) {
    res.setHeader("Content-Range", `bytes */${details.total_size}`)
  }

  res.status(status).set(PRIVATE_NO_STORE_HEADERS).json({
    type: code,
    code,
    message,
    ...(details ? { details } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  })
}

export const digitalDownloadsErrorHandler: MedusaErrorHandlerFunction = (
  error,
  req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error)
    return
  }
  if (!isDigitalDownloadsApiPath(req.path)) {
    defaultMedusaErrorHandler(error, req, res, next)
    return
  }
  sendApiError(res, error)
}
