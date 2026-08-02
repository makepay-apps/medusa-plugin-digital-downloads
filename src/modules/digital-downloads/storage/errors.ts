const SAFE_PROVIDER_CODES = new Set([
  "AccessDenied",
  "AuthorizationHeaderMalformed",
  "CredentialsProviderError",
  "EntityTooLarge",
  "ExpiredToken",
  "InternalError",
  "InvalidArgument",
  "InvalidObjectState",
  "InvalidRange",
  "InvalidRequest",
  "NetworkingError",
  "NoSuchBucket",
  "NoSuchKey",
  "NotFound",
  "PreconditionFailed",
  "RequestAbortedError",
  "RequestTimeout",
  "ServiceUnavailable",
  "SignatureDoesNotMatch",
  "SlowDown",
  "TimeoutError",
])

type ProviderErrorShape = {
  code?: unknown
  name?: unknown
  status?: unknown
  statusCode?: unknown
  $metadata?: { httpStatusCode?: unknown }
  $response?: { statusCode?: unknown }
}

export type SanitizedStorageProviderError = Error & {
  code: string
  status?: number
}

function shapeOf(error: unknown): ProviderErrorShape {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return {}
  }
  try {
    return error as ProviderErrorShape
  } catch {
    return {}
  }
}

export function safeProviderStatus(error: unknown): number | undefined {
  const candidate = shapeOf(error)
  let value: unknown
  try {
    value =
      candidate.$metadata?.httpStatusCode ??
      candidate.$response?.statusCode ??
      candidate.statusCode ??
      candidate.status
  } catch {
    return undefined
  }
  return Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : undefined
}

export function safeProviderCode(error: unknown): string | undefined {
  const candidate = shapeOf(error)
  let value: unknown
  try {
    value = candidate.code ?? candidate.name
  } catch {
    return undefined
  }
  if (typeof value !== "string") {
    return undefined
  }

  // POSIX/Node system codes and this fixed provider-code allowlist are safe to
  // expose. Arbitrary provider strings are deliberately discarded.
  if (/^E[A-Z0-9_]{1,31}$/.test(value) || SAFE_PROVIDER_CODES.has(value)) {
    return value
  }
  return undefined
}

/**
 * Converts an untrusted SDK/filesystem exception into a fresh, minimal error.
 * In particular, no provider error, request object, path, endpoint, or cause is
 * retained on the returned value.
 */
export function sanitizedProviderError(
  provider: "local" | "s3",
  operation: string,
  error: unknown,
): SanitizedStorageProviderError {
  const status = safeProviderStatus(error)
  const providerCode = safeProviderCode(error)
  const code = providerCode ?? (provider === "s3" ? "S3_PROVIDER_ERROR" : "LOCAL_IO_ERROR")
  const sanitized = new Error(
    `${provider.toUpperCase()} storage ${operation} failed (${code})`,
  ) as SanitizedStorageProviderError
  sanitized.name = "StorageProviderError"
  sanitized.code = code
  if (status !== undefined) {
    sanitized.status = status
  }
  return sanitized
}

export async function withSanitizedProviderError<T>(
  provider: "local" | "s3",
  operation: string,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback()
  } catch (error) {
    throw sanitizedProviderError(provider, operation, error)
  }
}

export function withSanitizedProviderErrorSync<T>(
  provider: "local" | "s3",
  operation: string,
  callback: () => T,
): T {
  try {
    return callback()
  } catch (error) {
    throw sanitizedProviderError(provider, operation, error)
  }
}
