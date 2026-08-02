import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

const ENVELOPE_VERSION = "v1"
const KEY_CONTEXT = "medusa-digital-downloads/license-key/v1"
const ENCRYPTION_FINGERPRINT_CONTEXTS = new Set(["license-key", "device"])

function requireSecret(secret: string | undefined, name: string): string {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`)
  }
  return secret
}

function requireEncryptionKey(secret: string | undefined): string {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error(
      "Encryption key must be exactly 64 hexadecimal characters (32 bytes)",
    )
  }
  return secret
}

function encryptionKey(secret: string | undefined): Buffer {
  return createHash("sha256")
    .update(KEY_CONTEXT)
    .update("\0")
    .update(requireEncryptionKey(secret))
    .digest()
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Encrypted secret envelope is malformed")
  }
  const decoded = Buffer.from(value, "base64url")
  if (!decoded.length || decoded.toString("base64url") !== value) {
    throw new Error("Encrypted secret envelope is malformed")
  }
  return decoded
}

export function sha256(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

export function keyedFingerprint(
  value: string,
  secret: string | undefined,
  context = "generic",
): string {
  const key = ENCRYPTION_FINGERPRINT_CONTEXTS.has(context)
    ? requireEncryptionKey(secret)
    : requireSecret(secret, "Fingerprint secret")
  return createHmac("sha256", key)
    .update(`medusa-digital-downloads/${context}/v1\0`)
    .update(value)
    .digest("hex")
}

export function normalizeAndFingerprint(
  value: string | undefined,
  secret: string | undefined,
  context: "ip" | "user-agent" | "device" | "recipient",
): string | null {
  if (!value) {
    return null
  }
  const normalized =
    context === "recipient"
      ? value.trim().toLowerCase()
      : value.trim().replace(/\s+/g, " ")
  return keyedFingerprint(normalized, secret, context)
}

export function randomOpaqueToken(prefix = "ddg", bytes = 32): string {
  if (!/^[a-z][a-z0-9]{1,15}$/i.test(prefix)) {
    throw new Error("Token prefix is invalid")
  }
  if (!Number.isSafeInteger(bytes) || bytes < 24 || bytes > 64) {
    throw new Error("Token entropy must be between 24 and 64 bytes")
  }
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`
}

/** Produces a repeatable, secret bearer token for an idempotency key. */
export function deriveOpaqueToken(
  idempotencyKey: string,
  secret: string | undefined,
  prefix = "ddg",
): string {
  if (!idempotencyKey || idempotencyKey.length > 512) {
    throw new Error("A bounded idempotency key is required")
  }
  const key = requireSecret(secret, "Token secret")
  const digest = createHmac("sha256", key)
    .update("medusa-digital-downloads/opaque-token/v1\0")
    .update(prefix)
    .update("\0")
    .update(idempotencyKey)
    .digest("base64url")
  return `${prefix}_${digest}`
}

export function tokenHash(
  token: string,
  secret: string | undefined,
): string {
  if (!token || token.length > 1024) {
    throw new Error("Token is invalid")
  }
  return keyedFingerprint(token, secret, "download-token")
}

export function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

export function encryptSecret(
  plaintext: string,
  secret: string | undefined,
): string {
  if (!plaintext || Buffer.byteLength(plaintext, "utf8") > 16_384) {
    throw new Error("Secret plaintext must contain between 1 and 16384 bytes")
  }
  const key = encryptionKey(secret)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(KEY_CONTEXT, "utf8"))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

export function decryptSecret(
  envelope: string,
  secret: string | undefined,
): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = envelope.split(".")
  if (
    version !== ENVELOPE_VERSION ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra !== undefined
  ) {
    throw new Error("Encrypted secret envelope is malformed or unsupported")
  }

  const iv = decodeCanonicalBase64Url(ivValue)
  const tag = decodeCanonicalBase64Url(tagValue)
  const ciphertext = decodeCanonicalBase64Url(ciphertextValue)
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 16_400) {
    throw new Error("Encrypted secret envelope is malformed")
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    iv,
  )
  decipher.setAAD(Buffer.from(KEY_CONTEXT, "utf8"))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  )
}
