import path from "node:path"
import { MedusaError } from "@medusajs/framework/utils"
import {
  DigitalStorageProvider,
  type DigitalDownloadsModuleOptions,
  type DigitalDownloadsS3StorageOptions,
  type RevocationPolicy,
  type ResolvedDigitalDownloadsModuleOptions,
} from "../types"
import { sha256 } from "./crypto"

const MEBIBYTE = 1024 * 1024
const MAX_UPLOAD_SIZE = 1024 * 1024 * MEBIBYTE
const MAX_GRANT_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_MAX_UPLOAD_SIZE = 5 * 1024 * MEBIBYTE
const REVOCATION_POLICIES = new Set<RevocationPolicy>([
  "retain",
  "any_refund",
  "full_refund",
  "refunded_items",
  "all",
])

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

function optionalSecret(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }

  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    invalid(`${name} must contain at least 32 bytes`)
  }

  return value
}

function optionalEncryptionKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }

  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    invalid(
      "encryptionKey must be exactly 64 hexadecimal characters (32 bytes)",
    )
  }

  return value
}

function integer(
  value: unknown,
  name: string,
  { min, max }: { min: number; max: number },
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${name} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function normalizeMimeTypes(value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    invalid("allowedMimeTypes must be an array")
  }

  const normalized = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+))$/i.test(entry)
    ) {
      invalid(`Invalid MIME type pattern: ${String(entry)}`)
    }
    return entry.toLowerCase()
  })

  return [...new Set(normalized)]
}

function revocationPolicy(
  value: unknown,
  name: string,
  fallback: RevocationPolicy,
): RevocationPolicy {
  const resolved = value ?? fallback
  if (!REVOCATION_POLICIES.has(resolved as RevocationPolicy)) {
    invalid(`${name} is not a supported revocation policy`)
  }
  return resolved as RevocationPolicy
}

function normalizeEndpoint(
  endpoint: string,
  allowInsecureEndpoint: boolean,
): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    invalid("storage.s3.endpoint must be an absolute HTTP(S) URL")
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    invalid("storage.s3.endpoint must use HTTP or HTTPS")
  }
  if (parsed.protocol !== "https:" && !allowInsecureEndpoint) {
    invalid(
      "storage.s3.endpoint must use HTTPS unless allowInsecureEndpoint is explicitly enabled",
    )
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    invalid("storage.s3.endpoint cannot include credentials, query, or fragment")
  }

  return parsed.toString().replace(/\/$/, "")
}

function resolveS3Options(
  configured: DigitalDownloadsS3StorageOptions | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedDigitalDownloadsModuleOptions["storage"]["s3"] {
  const bucket = configured?.bucket ?? env.DIGITAL_DOWNLOADS_S3_BUCKET
  const accessKeyId =
    configured?.accessKeyId ?? env.DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID
  const secretAccessKey =
    configured?.secretAccessKey ?? env.DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY

  if (!bucket && !accessKeyId && !secretAccessKey && !configured) {
    return undefined
  }
  if (!bucket || !accessKeyId || !secretAccessKey) {
    invalid(
      "S3 storage requires bucket, accessKeyId, and secretAccessKey",
    )
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    invalid("storage.s3.bucket is not a valid S3 bucket name")
  }

  const region = configured?.region ?? env.DIGITAL_DOWNLOADS_S3_REGION ?? "us-east-1"
  if (!/^[a-z0-9-]{1,64}$/i.test(region)) {
    invalid("storage.s3.region is invalid")
  }
  const allowInsecureEndpoint = configured?.allowInsecureEndpoint ?? false
  const endpoint = normalizeEndpoint(
    configured?.endpoint ??
      env.DIGITAL_DOWNLOADS_S3_ENDPOINT ??
      `https://s3.${region}.amazonaws.com`,
    allowInsecureEndpoint,
  )
  const prefix = (configured?.prefix ?? env.DIGITAL_DOWNLOADS_S3_PREFIX ?? "")
    .replace(/^\/+|\/+$/g, "")

  if (prefix.split("/").some((segment) => segment === "..")) {
    invalid("storage.s3.prefix cannot contain parent-directory segments")
  }

  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken:
      configured?.sessionToken ?? env.DIGITAL_DOWNLOADS_S3_SESSION_TOKEN,
    endpoint,
    region,
    forcePathStyle: configured?.forcePathStyle ?? false,
    allowInsecureEndpoint,
    prefix,
  }
}

export function resolveDigitalDownloadsOptions(
  options: DigitalDownloadsModuleOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDigitalDownloadsModuleOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    invalid("Digital downloads module options must be an object")
  }

  const defaultGrantTtlSeconds = integer(
    options.defaultGrantTtlSeconds ?? 900,
    "defaultGrantTtlSeconds",
    { min: 30, max: MAX_GRANT_TTL_SECONDS },
  )
  const maxGrantTtlSeconds = integer(
    options.maxGrantTtlSeconds ?? 86400,
    "maxGrantTtlSeconds",
    { min: defaultGrantTtlSeconds, max: MAX_GRANT_TTL_SECONDS },
  )
  const defaultDownloadLimit =
    options.defaultDownloadLimit === null
      ? null
      : integer(options.defaultDownloadLimit ?? 5, "defaultDownloadLimit", {
          min: 0,
          max: 1_000_000,
        })
  const maxUploadSizeBytes = integer(
    options.maxUploadSizeBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
    "maxUploadSizeBytes",
    { min: 1, max: MAX_UPLOAD_SIZE },
  )

  const defaultProvider =
    options.storage?.defaultProvider ?? DigitalStorageProvider.LOCAL
  if (!Object.values(DigitalStorageProvider).includes(defaultProvider as DigitalStorageProvider)) {
    invalid(`Unsupported storage provider: ${String(defaultProvider)}`)
  }

  const tokenSecret = optionalSecret(
    options.tokenSecret ?? env.DIGITAL_DOWNLOADS_TOKEN_SECRET,
    "tokenSecret",
  )
  const encryptionKey = optionalEncryptionKey(
    options.encryptionKey ?? env.DIGITAL_DOWNLOADS_ENCRYPTION_KEY,
  )
  if (tokenSecret && encryptionKey === tokenSecret) {
    invalid("encryptionKey must be different from tokenSecret")
  }
  const localSigningSecret = optionalSecret(
    options.storage?.local?.signingSecret ??
      env.DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET ??
      tokenSecret,
    "storage.local.signingSecret",
  )
  const s3 = resolveS3Options(options.storage?.s3, env)

  if (defaultProvider === DigitalStorageProvider.S3 && !s3) {
    invalid("S3 is the default provider but no S3 configuration was supplied")
  }

  return {
    storage: {
      defaultProvider: defaultProvider as DigitalStorageProvider,
      local: {
        rootPath: path.resolve(
          options.storage?.local?.rootPath ??
            env.DIGITAL_DOWNLOADS_LOCAL_ROOT ??
            path.join(process.cwd(), ".medusa", "digital-downloads"),
        ),
        signingSecret: localSigningSecret ?? "",
      },
      s3,
    },
    tokenSecret,
    encryptionKey,
    defaultDownloadLimit,
    defaultGrantTtlSeconds,
    maxGrantTtlSeconds,
    maxUploadSizeBytes,
    allowedMimeTypes: normalizeMimeTypes(options.allowedMimeTypes),
    allowGuestAccess: options.allowGuestAccess ?? true,
    refundPolicy: revocationPolicy(
      options.refundPolicy,
      "refundPolicy",
      "full_refund",
    ),
    cancellationPolicy: revocationPolicy(
      options.cancellationPolicy,
      "cancellationPolicy",
      "all",
    ),
  }
}

/**
 * Stable identifier for the physical object namespace. Credentials and signing
 * secrets are deliberately excluded. A mismatch must be handled as an explicit
 * storage migration so historical asset locators cannot silently point elsewhere.
 */
export function digitalDownloadsStorageNamespaceFingerprint(
  options: ResolvedDigitalDownloadsModuleOptions,
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      local_root: path.normalize(options.storage.local.rootPath),
      s3: options.storage.s3
        ? {
            endpoint: options.storage.s3.endpoint.replace(/\/$/, ""),
            bucket: options.storage.s3.bucket,
            prefix: options.storage.s3.prefix.replace(/^\/+|\/+$/g, ""),
          }
        : null,
    }),
  )
}

export function assertMimeTypeAllowed(
  mimeType: string,
  allowedMimeTypes: string[],
): void {
  const normalized = mimeType.toLowerCase().split(";", 1)[0].trim()
  if (!normalized.includes("/") || /[\r\n]/.test(normalized)) {
    invalid("Invalid MIME type")
  }
  if (!allowedMimeTypes.length || allowedMimeTypes.includes("*/*")) {
    return
  }
  const [type] = normalized.split("/", 1)
  if (
    !allowedMimeTypes.includes(normalized) &&
    !allowedMimeTypes.includes(`${type}/*`)
  ) {
    invalid(`MIME type ${normalized} is not allowed`)
  }
}

export function assertSafeAttribution(value: {
  attribution_label?: unknown
  attribution_url?: unknown
}): void {
  if (
    value.attribution_label !== undefined &&
    value.attribution_label !==
      "Brought to you by MakePay.io — crypto payment gateway."
  ) {
    invalid("attribution_label is fixed and cannot contain custom content")
  }
  if (
    value.attribution_url !== undefined &&
    value.attribution_url !== "https://makepay.io"
  ) {
    invalid("attribution_url is fixed to https://makepay.io")
  }
}
