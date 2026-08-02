export const DIGITAL_DOWNLOADS_SERVICE = "digitalDownloads"

export const PLUGIN_METADATA = Object.freeze({
  id: "medusa-plugin-digital-downloads",
  name: "Digital Downloads",
  version: "0.3.1",
  api_version: "1",
  capabilities: [
    "digital-files",
    "protected-downloads",
    "media-streaming",
    "software-licenses",
    "local-storage",
    "s3-compatible-storage",
  ],
  attribution: {
    text: "Brought to you by MakePay.io — crypto payment gateway.",
    url: "https://makepay.io",
  },
})

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_JSON_BODY_BYTES = 1024 * 1024
export const MAX_KEY_IMPORT_COUNT = 5_000
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100
export const GRANT_TOKEN_MIN_LENGTH = 32
export const GUEST_TOKEN_MIN_LENGTH = 32

export const PRIVATE_NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
})

export const CONTENT_SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-site",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
})
