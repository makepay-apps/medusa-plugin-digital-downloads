import { randomInt } from "node:crypto"

const ALPHABETS = {
  ALPHA: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  NUM: "0123456789",
  ALNUM: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  HEX: "0123456789ABCDEF",
} as const

const TOKEN = /\{(ALPHA|NUM|ALNUM|HEX):(\d{1,2})\}|X/g

export const DEFAULT_LICENSE_PATTERN =
  "{ALNUM:5}-{ALNUM:5}-{ALNUM:5}-{ALNUM:5}"

export function validateLicensePattern(pattern: string): void {
  if (!pattern || pattern.length > 128 || /[\r\n\0]/.test(pattern)) {
    throw new Error("License pattern must contain 1-128 safe characters")
  }

  let entropyCharacters = 0
  let cursor = 0
  let match: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((match = TOKEN.exec(pattern))) {
    const literal = pattern.slice(cursor, match.index)
    if (!/^[A-Za-z0-9._-]*$/.test(literal)) {
      throw new Error("License pattern contains unsupported literal characters")
    }
    const count = match[0] === "X" ? 1 : Number.parseInt(match[2], 10)
    if (count < 1 || count > 64) {
      throw new Error("License pattern segment length must be between 1 and 64")
    }
    entropyCharacters += count
    cursor = match.index + match[0].length
  }
  if (!/^[A-Za-z0-9._-]*$/.test(pattern.slice(cursor))) {
    throw new Error("License pattern contains unsupported literal characters")
  }
  if (entropyCharacters < 16 || entropyCharacters > 96) {
    throw new Error("License pattern must contain 16-96 generated characters")
  }
}

function randomCharacters(alphabet: string, count: number): string {
  let result = ""
  for (let index = 0; index < count; index += 1) {
    result += alphabet[randomInt(0, alphabet.length)]
  }
  return result
}

export function generateLicenseKey(
  pattern = DEFAULT_LICENSE_PATTERN,
): string {
  validateLicensePattern(pattern)
  TOKEN.lastIndex = 0
  return pattern.replace(TOKEN, (matched, alphabetName: keyof typeof ALPHABETS, count) => {
    if (matched === "X") {
      return randomCharacters(ALPHABETS.ALNUM, 1)
    }
    return randomCharacters(ALPHABETS[alphabetName], Number.parseInt(count, 10))
  })
}

export function normalizeLicenseKey(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!normalized || normalized.length > 512 || /[\r\n\0]/.test(normalized)) {
    throw new Error("License key is invalid")
  }
  return normalized
}

export function licenseKeyHint(value: string): string {
  const normalized = normalizeLicenseKey(value)
  const visible = normalized.replace(/[^A-Z0-9]/g, "").slice(-4)
  return visible ? `••••-${visible}` : "••••"
}
