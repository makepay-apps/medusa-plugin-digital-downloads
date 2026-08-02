#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const fixtureInput = process.env.E2E_FIXTURE_ROOT?.trim()
if (!fixtureInput || !path.isAbsolute(fixtureInput)) {
  throw new Error("E2E_FIXTURE_ROOT must be an absolute disposable fixture path")
}

const fixtureRoot = realpathSync(fixtureInput)
const includeStorefront = !process.argv.slice(2).includes("--skip-storefront")
const repositoryRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
)
const protectedRoots = new Set([
  path.parse(fixtureRoot).root,
  realpathSync(homedir()),
  repositoryRoot,
  "/Users",
  "/home",
  "/private/tmp",
  "/private/var",
  "/tmp",
  "/var",
  "/Volumes",
])
if (protectedRoots.has(fixtureRoot)) {
  throw new Error("E2E_FIXTURE_ROOT is too broad or protected")
}

function assertDescendant(target, kind = "path") {
  const canonical = realpathSync(target)
  const relative = path.relative(fixtureRoot, canonical)
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${kind} must resolve below the disposable fixture root`)
  }
  return canonical
}

const appRoot = assertDescendant(
  path.join(fixtureRoot, "medusa-app"),
  "Medusa fixture",
)
const backendRoot = assertDescendant(
  path.join(appRoot, "apps/backend"),
  "backend fixture",
)
const storefrontRoot = assertDescendant(
  path.join(appRoot, "apps/storefront"),
  "storefront fixture",
)
const minioRoot = assertDescendant(
  path.join(fixtureRoot, "minio"),
  "MinIO fixture",
)

const markerPath = assertDescendant(path.join(appRoot, "FIXTURE.md"), "fixture marker")
if (!readFileSync(markerPath, "utf8").includes("Digital Downloads E2E Fixture")) {
  throw new Error("Fixture marker did not identify the disposable digital-downloads fixture")
}

const schemas = {
  backend: {
    path: path.join(backendRoot, ".env"),
    allowed: new Set([
      "NODE_ENV",
      "PORT",
      "DATABASE_URL",
      "DB_NAME",
      "STORE_CORS",
      "ADMIN_CORS",
      "AUTH_CORS",
      "JWT_SECRET",
      "COOKIE_SECRET",
      "E2E_ADMIN_EMAIL",
      "E2E_ADMIN_PASSWORD",
      "DIGITAL_DOWNLOADS_LOCAL_ROOT",
      "DIGITAL_DOWNLOADS_TOKEN_SECRET",
      "DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET",
      "DIGITAL_DOWNLOADS_ENCRYPTION_KEY",
      "DIGITAL_DOWNLOADS_PRIVACY_SALT",
    ]),
    required: new Set([
      "DATABASE_URL",
      "STORE_CORS",
      "ADMIN_CORS",
      "AUTH_CORS",
      "JWT_SECRET",
      "COOKIE_SECRET",
      "E2E_ADMIN_EMAIL",
      "E2E_ADMIN_PASSWORD",
      "DIGITAL_DOWNLOADS_LOCAL_ROOT",
      "DIGITAL_DOWNLOADS_TOKEN_SECRET",
      "DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET",
      "DIGITAL_DOWNLOADS_ENCRYPTION_KEY",
    ]),
    emit: new Set([
      "DATABASE_URL",
      "STORE_CORS",
      "ADMIN_CORS",
      "AUTH_CORS",
      "JWT_SECRET",
      "COOKIE_SECRET",
      "E2E_ADMIN_EMAIL",
      "E2E_ADMIN_PASSWORD",
      "DIGITAL_DOWNLOADS_LOCAL_ROOT",
      "DIGITAL_DOWNLOADS_TOKEN_SECRET",
      "DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET",
      "DIGITAL_DOWNLOADS_ENCRYPTION_KEY",
      "DIGITAL_DOWNLOADS_PRIVACY_SALT",
    ]),
  },
  storefront: {
    path: path.join(storefrontRoot, ".env.local"),
    allowed: new Set([
      "NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_MEDUSA_BACKEND_URL",
      "NEXT_PUBLIC_DEFAULT_REGION",
      "NEXT_PUBLIC_BASE_URL",
      "NEXT_PUBLIC_STRIPE_KEY",
      "MEDUSA_CLOUD_S3_HOSTNAME",
      "MEDUSA_CLOUD_S3_PATHNAME",
      "NODE_ENV",
    ]),
    required: new Set(["NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY"]),
    emit: new Set([
      "NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_DEFAULT_REGION",
      "NEXT_PUBLIC_BASE_URL",
      "NEXT_PUBLIC_STRIPE_KEY",
      "MEDUSA_CLOUD_S3_HOSTNAME",
      "MEDUSA_CLOUD_S3_PATHNAME",
    ]),
  },
  minio: {
    path: path.join(minioRoot, "minio.env"),
    allowed: new Set([
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "MINIO_ADDRESS",
      "MINIO_CONSOLE_ADDRESS",
      "MINIO_BROWSER",
      "MINIO_REGION_NAME",
      "MINIO_FIXTURE_BUCKET",
      "MINIO_FIXTURE_PREFIX",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
      "AWS_ENDPOINT_URL_S3",
      "DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID",
      "DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY",
      "DIGITAL_DOWNLOADS_S3_REGION",
      "DIGITAL_DOWNLOADS_S3_ENDPOINT",
      "DIGITAL_DOWNLOADS_S3_BUCKET",
      "DIGITAL_DOWNLOADS_S3_PREFIX",
      "NO_PROXY",
      "no_proxy",
    ]),
    required: new Set([
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "MINIO_ADDRESS",
      "MINIO_CONSOLE_ADDRESS",
      "MINIO_REGION_NAME",
      "MINIO_FIXTURE_BUCKET",
      "MINIO_FIXTURE_PREFIX",
      "DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID",
      "DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY",
      "DIGITAL_DOWNLOADS_S3_REGION",
      "DIGITAL_DOWNLOADS_S3_ENDPOINT",
      "DIGITAL_DOWNLOADS_S3_BUCKET",
      "DIGITAL_DOWNLOADS_S3_PREFIX",
    ]),
    emit: new Set([
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "MINIO_ADDRESS",
      "MINIO_CONSOLE_ADDRESS",
      "MINIO_BROWSER",
      "MINIO_REGION_NAME",
      "DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID",
      "DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY",
      "DIGITAL_DOWNLOADS_S3_REGION",
      "DIGITAL_DOWNLOADS_S3_ENDPOINT",
      "DIGITAL_DOWNLOADS_S3_BUCKET",
      "DIGITAL_DOWNLOADS_S3_PREFIX",
    ]),
  },
}

function parseValue(raw, label, lineNumber) {
  const value = raw.trim()
  if (!value) return ""
  const quote = value[0]
  if (quote === "'" || quote === '"') {
    if (value.at(-1) !== quote) {
      throw new Error(`${label}:${lineNumber} has an unterminated quoted value`)
    }
    const inner = value.slice(1, -1)
    if (quote === "'") return inner
    return inner.replace(/\\(n|r|t|"|\\)/g, (_match, escaped) => {
      return { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" }[escaped]
    })
  }
  const comment = value.search(/\s+#/)
  return (comment === -1 ? value : value.slice(0, comment)).trimEnd()
}

function readSchema(name) {
  const schema = schemas[name]
  const envPath = assertDescendant(schema.path, `${name} environment file`)
  if (!statSync(envPath).isFile()) {
    throw new Error(`${name} environment path must be a regular file`)
  }
  const values = new Map()
  const lines = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`${name} environment line ${index + 1} is not dotenv data`)
    const [, key, rawValue] = match
    if (!schema.allowed.has(key)) {
      throw new Error(`${name} environment contains unexpected key ${key}`)
    }
    if (values.has(key)) {
      throw new Error(`${name} environment contains duplicate key ${key}`)
    }
    const value = parseValue(rawValue, name, index + 1)
    if (/[\u0000\r\n]/.test(value)) {
      throw new Error(`${name} environment key ${key} must be single-line data`)
    }
    values.set(key, value)
  }
  for (const key of schema.required) {
    if (!values.get(key)?.trim()) throw new Error(`${name} environment is missing ${key}`)
  }
  return { schema, values }
}

const backend = readSchema("backend")
// The backend-only lifecycle still calls authenticated Store API routes, so it
// always needs the fixture's publishable key. Keep validating this file as
// inert dotenv data even when installation/build/start of the storefront is
// skipped; only its public key is emitted in that mode.
const storefront = readSchema("storefront")
const minio = readSchema("minio")

const database = new URL(backend.values.get("DATABASE_URL"))
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  database.hostname !== "127.0.0.1" ||
  database.port !== "55432" ||
  database.pathname !== "/medusa_digital_downloads_e2e" ||
  database.search ||
  database.hash
) {
  throw new Error("DATABASE_URL must target only 127.0.0.1:55432/medusa_digital_downloads_e2e")
}

const localRoot = assertDescendant(
  backend.values.get("DIGITAL_DOWNLOADS_LOCAL_ROOT"),
  "local storage root",
)
if (localRoot !== assertDescendant(path.join(fixtureRoot, "storage"), "fixture storage root")) {
  throw new Error("DIGITAL_DOWNLOADS_LOCAL_ROOT must be the fixture storage directory")
}

const s3Endpoint = new URL(minio.values.get("DIGITAL_DOWNLOADS_S3_ENDPOINT"))
if (s3Endpoint.href !== "http://127.0.0.1:9400/") {
  throw new Error("DIGITAL_DOWNLOADS_S3_ENDPOINT must be http://127.0.0.1:9400")
}
if (
  minio.values.get("MINIO_ADDRESS") !== "127.0.0.1:9400" ||
  minio.values.get("MINIO_CONSOLE_ADDRESS") !== "127.0.0.1:9401"
) {
  throw new Error("MinIO API and console addresses must use the dedicated loopback ports")
}
if (
  minio.values.get("DIGITAL_DOWNLOADS_S3_BUCKET") !==
    "makepay-digital-downloads-e2e" ||
  minio.values.get("MINIO_FIXTURE_BUCKET") !==
    minio.values.get("DIGITAL_DOWNLOADS_S3_BUCKET")
) {
  throw new Error("S3 bucket must be the dedicated makepay-digital-downloads-e2e bucket")
}
if (
  minio.values.get("DIGITAL_DOWNLOADS_S3_PREFIX") !==
    "private/digital-downloads" ||
  minio.values.get("MINIO_FIXTURE_PREFIX") !==
    minio.values.get("DIGITAL_DOWNLOADS_S3_PREFIX")
) {
  throw new Error("S3 prefix must be the fixture's reserved private/digital-downloads prefix")
}

const sources = [backend, minio]
if (includeStorefront) {
  sources.splice(1, 0, storefront)
} else {
  sources.splice(1, 0, {
    schema: { emit: new Set(["NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY"]) },
    values: storefront.values,
  })
}

for (const { schema, values } of sources) {
  for (const key of schema.emit) {
    const value = values.get(key)
    if (value === undefined) continue
    process.stdout.write(
      `FIXTURE_${key}\t${Buffer.from(value, "utf8").toString("base64")}\n`,
    )
  }
}
