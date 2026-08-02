import { createCipheriv, createHash } from "node:crypto"

import {
  decryptSecret,
  deriveOpaqueToken,
  encryptSecret,
  keyedFingerprint,
  normalizeAndFingerprint,
  randomOpaqueToken,
  safeHashEqual,
  sha256,
  tokenHash,
} from "../src/modules/digital-downloads/utils/crypto"
import {
  generateLicenseKey,
  licenseKeyHint,
  normalizeLicenseKey,
  validateLicensePattern,
} from "../src/modules/digital-downloads/utils/license-pattern"

const SECRET_A = "token-secret-a:".repeat(3)
const SECRET_B = "token-secret-b:".repeat(3)
const ENCRYPTION_KEY_A = "a".repeat(64)
const ENCRYPTION_KEY_B = "b".repeat(64)
const ENCRYPTION_CONTEXT = "medusa-digital-downloads/license-key/v1"

function canonicalEnvelope(
  plaintext: string,
  secret: string,
  iv = Buffer.from("000102030405060708090a0b", "hex"),
): string {
  const key = createHash("sha256")
    .update(ENCRYPTION_CONTEXT)
    .update("\0")
    .update(secret)
    .digest()
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

describe("digital-download security primitives", () => {
  it("creates opaque high-entropy tokens and rejects unsafe parameters", () => {
    const first = randomOpaqueToken("ddg", 32)
    const second = randomOpaqueToken("ddg", 32)

    expect(first).toMatch(/^ddg_[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
    expect(() => randomOpaqueToken("../grant", 32)).toThrow(
      "Token prefix is invalid",
    )
    expect(() => randomOpaqueToken("ddg", 23)).toThrow(
      "Token entropy must be between 24 and 64 bytes",
    )
  })

  it("derives an idempotent bearer without weakening key separation", () => {
    const first = deriveOpaqueToken("order_1:item_1:0", SECRET_A)
    const retry = deriveOpaqueToken("order_1:item_1:0", SECRET_A)
    const nextUnit = deriveOpaqueToken("order_1:item_1:1", SECRET_A)
    const rotatedSecret = deriveOpaqueToken("order_1:item_1:0", SECRET_B)

    expect(retry).toBe(first)
    expect(nextUnit).not.toBe(first)
    expect(rotatedSecret).not.toBe(first)
    expect(first).toMatch(/^ddg_[A-Za-z0-9_-]{43}$/)
    expect(() => deriveOpaqueToken("", SECRET_A)).toThrow(
      "A bounded idempotency key is required",
    )
    expect(() => deriveOpaqueToken("key", "short")).toThrow(
      "Token secret must contain at least 32 bytes",
    )
  })

  it("uses keyed, context-separated, normalized privacy fingerprints", () => {
    const recipient = normalizeAndFingerprint(
      " Buyer@Example.COM ",
      SECRET_A,
      "recipient",
    )
    const sameRecipient = normalizeAndFingerprint(
      "buyer@example.com",
      SECRET_A,
      "recipient",
    )

    expect(recipient).toBe(sameRecipient)
    expect(keyedFingerprint("value", SECRET_A, "ip")).not.toBe(
      keyedFingerprint("value", SECRET_A, "recipient"),
    )
    expect(normalizeAndFingerprint(undefined, SECRET_A, "ip")).toBeNull()
  })

  it("requires canonical encryption material for license-derived fingerprints", () => {
    expect(keyedFingerprint("value", ENCRYPTION_KEY_A, "license-key")).not.toBe(
      keyedFingerprint("value", ENCRYPTION_KEY_A, "device"),
    )
    expect(() =>
      keyedFingerprint("value", SECRET_A, "license-key"),
    ).toThrow(
      "Encryption key must be exactly 64 hexadecimal characters (32 bytes)",
    )
    expect(() => keyedFingerprint("value", "g".repeat(64), "device")).toThrow(
      "Encryption key must be exactly 64 hexadecimal characters (32 bytes)",
    )
  })

  it("hashes bearer tokens with a secret and compares only valid digests", () => {
    const digest = tokenHash("grant-token", SECRET_A)

    expect(digest).toHaveLength(64)
    expect(safeHashEqual(digest, digest.toUpperCase())).toBe(true)
    expect(safeHashEqual(digest, tokenHash("other-token", SECRET_A))).toBe(false)
    expect(safeHashEqual("not-a-digest", digest)).toBe(false)
    expect(tokenHash("grant-token", SECRET_B)).not.toBe(digest)
    expect(() => tokenHash("", SECRET_A)).toThrow("Token is invalid")
  })

  it("encrypts recoverable license material with random authenticated envelopes", () => {
    const first = encryptSecret("AAAA-BBBB-CCCC", ENCRYPTION_KEY_A)
    const second = encryptSecret("AAAA-BBBB-CCCC", ENCRYPTION_KEY_A)

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(second).not.toBe(first)
    expect(decryptSecret(first, ENCRYPTION_KEY_A)).toBe("AAAA-BBBB-CCCC")
    expect(first).not.toContain("AAAA")
    expect(() => decryptSecret(first, ENCRYPTION_KEY_B)).toThrow()

    const parts = first.split(".")
    parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`
    expect(() => decryptSecret(parts.join("."), ENCRYPTION_KEY_A)).toThrow()
    expect(() => encryptSecret("", ENCRYPTION_KEY_A)).toThrow(
      "Secret plaintext must contain between 1 and 16384 bytes",
    )
  })

  it("rejects malformed encryption keys at the crypto boundary", () => {
    for (const encryptionKey of [
      undefined,
      "a".repeat(32),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
    ]) {
      expect(() => encryptSecret("AAAA-BBBB-CCCC", encryptionKey)).toThrow(
        "Encryption key must be exactly 64 hexadecimal characters (32 bytes)",
      )
    }

    const envelope = encryptSecret("AAAA-BBBB-CCCC", ENCRYPTION_KEY_A)
    expect(() => decryptSecret(envelope, SECRET_A)).toThrow(
      "Encryption key must be exactly 64 hexadecimal characters (32 bytes)",
    )
  })

  it("reads the canonical v1 envelope and supports explicit key rotation", () => {
    const canonical = canonicalEnvelope("AAAA-BBBB-CCCC", ENCRYPTION_KEY_A)
    const [version, iv, tag, ciphertext] = canonical.split(".")

    expect(version).toBe("v1")
    expect(Buffer.from(iv, "base64url")).toHaveLength(12)
    expect(Buffer.from(tag, "base64url")).toHaveLength(16)
    expect(Buffer.from(ciphertext, "base64url").toString("utf8")).not.toContain(
      "AAAA",
    )
    expect(decryptSecret(canonical, ENCRYPTION_KEY_A)).toBe("AAAA-BBBB-CCCC")

    const rotated = encryptSecret(
      decryptSecret(canonical, ENCRYPTION_KEY_A),
      ENCRYPTION_KEY_B,
    )
    expect(decryptSecret(rotated, ENCRYPTION_KEY_B)).toBe("AAAA-BBBB-CCCC")
    expect(() => decryptSecret(canonical, ENCRYPTION_KEY_B)).toThrow()
    expect(() => decryptSecret(rotated, ENCRYPTION_KEY_A)).toThrow()
  })

  it.each([
    [
      "unsupported version",
      (parts: string[]) => ["v2", ...parts.slice(1)].join("."),
    ],
    ["missing segment", (parts: string[]) => parts.slice(0, 3).join(".")],
    ["extra segment", (parts: string[]) => `${parts.join(".")}.extra`],
    [
      "padded base64url",
      (parts: string[]) =>
        `${parts[0]}.${parts[1]}=.${parts[2]}.${parts[3]}`,
    ],
    [
      "standard base64 alphabet",
      (parts: string[]) =>
        `${parts[0]}.+/+/.${parts[2]}.${parts[3]}`,
    ],
    [
      "empty ciphertext",
      (parts: string[]) => `${parts[0]}.${parts[1]}.${parts[2]}.`,
    ],
    [
      "wrong IV length",
      (parts: string[]) => `${parts[0]}.AA.${parts[2]}.${parts[3]}`,
    ],
    [
      "wrong tag length",
      (parts: string[]) => `${parts[0]}.${parts[1]}.AA.${parts[3]}`,
    ],
  ])("rejects a malformed envelope with %s", (_name, mutate) => {
    const parts = encryptSecret("x", ENCRYPTION_KEY_A).split(".")

    expect(() => decryptSecret(mutate(parts), ENCRYPTION_KEY_A)).toThrow(
      /malformed|unsupported/,
    )
  })

  it("rejects a noncanonical base64url spelling even when it decodes identically", () => {
    const parts = encryptSecret("x", ENCRYPTION_KEY_A).split(".")
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const ciphertext = parts[3]
    const lastIndex = alphabet.indexOf(ciphertext.at(-1)!)
    // A one-byte ciphertext has four unused low bits. Altering only one of
    // those pad bits produces the same byte in permissive base64 decoders.
    expect(lastIndex % 16).toBe(0)
    const noncanonical = `${ciphertext.slice(0, -1)}${alphabet[lastIndex + 1]}`
    expect(Buffer.from(noncanonical, "base64url")).toEqual(
      Buffer.from(ciphertext, "base64url"),
    )
    parts[3] = noncanonical

    expect(() => decryptSecret(parts.join("."), ENCRYPTION_KEY_A)).toThrow(
      "Encrypted secret envelope is malformed",
    )
  })

  it("keeps SHA-256 behavior stable for persisted checksums", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})

describe("license pattern and display policy", () => {
  it("generates keys from bounded unambiguous alphabets", () => {
    const key = generateLicenseKey("MP-{ALNUM:8}-{HEX:8}")

    expect(key).toMatch(/^MP-[A-HJ-NP-Z2-9]{8}-[0-9A-F]{8}$/)
    expect(key.split("-")[1]).not.toMatch(/[01IO]/)
  })

  it("rejects weak, oversized, and unsafe patterns", () => {
    expect(() => validateLicensePattern("{ALNUM:15}")).toThrow(
      "16-96 generated characters",
    )
    expect(() => validateLicensePattern("{ALNUM:64}{ALNUM:64}")).toThrow(
      "16-96 generated characters",
    )
    expect(() => validateLicensePattern("PREFIX/{ALNUM:16}")).toThrow(
      "unsupported literal characters",
    )
  })

  it("normalizes lookup values and exposes only a short hint", () => {
    expect(normalizeLicenseKey(" abcd-efgh ")).toBe("ABCD-EFGH")
    expect(licenseKeyHint("AAAA-BBBB-12cD")).toBe("••••-12CD")
    expect(() => normalizeLicenseKey("bad\nkey")).toThrow(
      "License key is invalid",
    )
  })
})
