#!/usr/bin/env node

import { createRequire } from "node:module"
import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const fixtureRootInput = process.env.E2E_FIXTURE_ROOT?.trim()
if (!fixtureRootInput || !path.isAbsolute(fixtureRootInput)) {
  throw new Error("E2E_FIXTURE_ROOT must be an absolute disposable fixture path")
}
const FIXTURE_ROOT = realpathSync(path.resolve(fixtureRootInput))
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const BACKEND_ROOT = path.join(FIXTURE_ROOT, "medusa-app/apps/backend")

function isDescendant(root, target) {
  const relative = path.relative(root, target)
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing fixture environment variable ${name}`)
  return value
}

if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
  throw new Error("DIGITAL_DOWNLOADS_E2E=1 is required")
}
if (
  new Set([
    path.parse(FIXTURE_ROOT).root,
    path.resolve(homedir()),
    REPOSITORY_ROOT,
    "/Users",
    "/home",
    "/tmp",
    "/var",
    "/Volumes",
  ]).has(FIXTURE_ROOT) ||
  !readFileSync(path.join(FIXTURE_ROOT, "medusa-app/FIXTURE.md"), "utf8").includes(
    "Digital Downloads E2E Fixture",
  )
) {
  throw new Error("E2E_FIXTURE_ROOT is not the marked narrow disposable fixture")
}
const canonicalBackendRoot = realpathSync(BACKEND_ROOT)
if (!isDescendant(FIXTURE_ROOT, canonicalBackendRoot)) {
  throw new Error("Backend fixture must resolve below E2E_FIXTURE_ROOT")
}

const endpoint = new URL(required("DIGITAL_DOWNLOADS_S3_ENDPOINT"))
const bucket = required("DIGITAL_DOWNLOADS_S3_BUCKET")
const prefix = required("DIGITAL_DOWNLOADS_S3_PREFIX")
if (
  endpoint.href !== "http://127.0.0.1:9400/" ||
  bucket !== "makepay-digital-downloads-e2e" ||
  prefix !== "private/digital-downloads" ||
  required("MINIO_ADDRESS") !== "127.0.0.1:9400" ||
  required("MINIO_CONSOLE_ADDRESS") !== "127.0.0.1:9401"
) {
  throw new Error("MinIO setup is restricted to the dedicated loopback fixture")
}

const requireFromBackend = createRequire(path.join(BACKEND_ROOT, "package.json"))
const requireFromPlugin = createRequire(
  requireFromBackend.resolve("@makecrypto/medusa-plugin-digital-downloads/package.json"),
)
const {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  HeadBucketCommand,
  S3Client,
} = requireFromPlugin("@aws-sdk/client-s3")

const client = new S3Client({
  endpoint: endpoint.href,
  region: required("DIGITAL_DOWNLOADS_S3_REGION"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY"),
  },
})

function codeOf(error) {
  return error && typeof error === "object"
    ? String(error.name ?? error.Code ?? error.code ?? "")
    : ""
}

async function main() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (!["NotFound", "NoSuchBucket"].includes(codeOf(error))) throw error
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }

  try {
    await client.send(new GetBucketPolicyCommand({ Bucket: bucket }))
    throw new Error("The fixture bucket has a bucket policy; expected a private policy-free bucket")
  } catch (error) {
    if (!["NoSuchBucketPolicy", "NoSuchPolicy"].includes(codeOf(error))) throw error
  }

  const preflightUrl = new URL(
    `${encodeURIComponent(bucket)}/fixture-browser-upload`,
    endpoint.href.endsWith("/") ? endpoint : `${endpoint.href}/`,
  )
  const preflight = await fetch(preflightUrl, {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:9100",
      "access-control-request-method": "PUT",
      "access-control-request-headers":
        "content-type,if-none-match,x-amz-checksum-sha256",
    },
    redirect: "manual",
  })
  if (
    !preflight.ok ||
    preflight.headers.get("access-control-allow-origin") !==
      "http://127.0.0.1:9100" ||
    !preflight.headers
      .get("access-control-allow-methods")
      ?.split(",")
      .map((method) => method.trim().toUpperCase())
      .includes("PUT")
  ) {
    throw new Error(
      `MinIO browser-upload CORS preflight failed with status ${preflight.status}`,
    )
  }

  process.stdout.write(
    "MinIO fixture bucket is private and its loopback browser-upload CORS configuration is active.\n",
  )
}

main()
  .catch((error) => {
    process.stderr.write(`MinIO fixture validation failed: ${error.message}\n`)
    process.exitCode = 1
  })
  .finally(() => client.destroy())
