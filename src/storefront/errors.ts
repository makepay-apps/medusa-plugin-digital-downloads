import type { DigitalDownloadsApiErrorBody } from "./types"

export interface DigitalDownloadsErrorOptions {
  status?: number
  code?: string
  requestId?: string
  retryAfter?: number
  details?: unknown
  cause?: unknown
}

/** A normalized error shared by the native-fetch and Medusa SDK adapters. */
export class DigitalDownloadsError extends Error {
  readonly status?: number
  readonly code?: string
  readonly requestId?: string
  readonly retryAfter?: number
  readonly details?: unknown

  constructor(message: string, options: DigitalDownloadsErrorOptions = {}) {
    super(message)
    this.name = "DigitalDownloadsError"
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      })
    }
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
    this.retryAfter = options.retryAfter
    this.details = options.details
  }
}

export const isDigitalDownloadsError = (
  error: unknown
): error is DigitalDownloadsError => error instanceof DigitalDownloadsError

const finiteStatus = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Medusa SDK errors vary slightly between SDK versions. This function only
 * reads common, non-sensitive fields and never serializes the complete error.
 */
export const normalizeDigitalDownloadsError = (
  error: unknown,
  fallbackMessage = "The digital downloads request failed."
): DigitalDownloadsError => {
  if (isDigitalDownloadsError(error)) {
    return error
  }

  if (!error || typeof error !== "object") {
    return new DigitalDownloadsError(
      typeof error === "string" ? error : fallbackMessage,
      {}
    )
  }

  const candidate = error as {
    message?: unknown
    status?: unknown
    statusCode?: unknown
    code?: unknown
    request_id?: unknown
    details?: unknown
    response?: {
      status?: unknown
      data?: DigitalDownloadsApiErrorBody
    }
  }
  const body = candidate.response?.data

  return new DigitalDownloadsError(
    optionalString(body?.message) ?? optionalString(candidate.message) ?? fallbackMessage,
    {
      status:
        finiteStatus(candidate.response?.status) ??
        finiteStatus(candidate.status) ??
        finiteStatus(candidate.statusCode),
      code: optionalString(body?.code) ?? optionalString(candidate.code),
      requestId:
        optionalString(body?.request_id) ?? optionalString(candidate.request_id),
      details: body?.details ?? candidate.details,
    }
  )
}
