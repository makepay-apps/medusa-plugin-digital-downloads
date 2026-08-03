#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const PLUGIN_NAME = "@makecrypto/medusa-plugin-digital-downloads"
const EXPECTED_VERSION = "0.4.0"
const FIXTURE_ROOT_INPUT = process.env.E2E_FIXTURE_ROOT?.trim()
if (!FIXTURE_ROOT_INPUT || !path.isAbsolute(FIXTURE_ROOT_INPUT)) {
  throw new Error("E2E_FIXTURE_ROOT must be an absolute disposable fixture path")
}
const FIXTURE_ROOT = realpathSync(path.resolve(FIXTURE_ROOT_INPUT))
const SKIP_STOREFRONT = process.argv.slice(2).includes("--skip-storefront")
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const APP_ROOT = path.join(FIXTURE_ROOT, "medusa-app")
const BACKEND_ROOT = path.join(APP_ROOT, "apps/backend")
const STOREFRONT_ROOT = path.join(APP_ROOT, "apps/storefront")
const CONFIG_PATH = path.join(BACKEND_ROOT, "medusa-config.ts")
const GENERATED_MARKER = "makepay-digital-downloads-packed-e2e-v2"
const NOTIFICATION_PROVIDER_ROOT = path.join(
  BACKEND_ROOT,
  "src/modules/digital-downloads-e2e-notification",
)
const NOTIFICATION_PROVIDER_INDEX_PATH = path.join(
  NOTIFICATION_PROVIDER_ROOT,
  "index.ts",
)
const NOTIFICATION_PROVIDER_SERVICE_PATH = path.join(
  NOTIFICATION_PROVIDER_ROOT,
  "service.ts",
)
const STOREFRONT_CONSUMER_PATH = path.join(
  STOREFRONT_ROOT,
  "src/app/[countryCode]/(main)/digital-downloads-e2e/page.tsx",
)
const STOREFRONT_CLIENT_PATH = path.join(
  STOREFRONT_ROOT,
  "src/app/[countryCode]/(main)/digital-downloads-e2e/client.tsx",
)
const STOREFRONT_STYLES_PATH = path.join(
  STOREFRONT_ROOT,
  "src/app/[countryCode]/(main)/digital-downloads-e2e/page.module.css",
)
const STOREFRONT_EMAIL_PREVIEW_PATH = path.join(
  STOREFRONT_ROOT,
  "src/app/api/digital-downloads-e2e/email-preview/route.ts",
)
const BACKUP_ROOT = path.join(FIXTURE_ROOT, "backups")
const RUNTIME_ROOT = path.join(FIXTURE_ROOT, "runtime")

function fail(message) {
  throw new Error(message)
}

function isDescendant(root, target) {
  const relative = path.relative(root, target)
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function assertExistingDescendant(target, label) {
  const canonical = await realpath(target).catch(() => undefined)
  if (!canonical || !isDescendant(FIXTURE_ROOT, canonical)) {
    fail(`${label} must resolve below the disposable fixture root`)
  }
  return canonical
}

async function assertWritableDescendant(target, label) {
  const existing = await realpath(target).catch(() => undefined)
  if (existing) {
    if (!isDescendant(FIXTURE_ROOT, existing)) {
      fail(`${label} resolves outside the disposable fixture root`)
    }
    return
  }
  let ancestor = path.dirname(target)
  while (ancestor !== path.dirname(ancestor)) {
    const canonical = await realpath(ancestor).catch(() => undefined)
    if (canonical) {
      // The fixture root itself is the expected nearest existing ancestor for
      // first-run directories such as backups/. The target remains a strict
      // descendant; only this ancestor check may accept equality.
      if (canonical !== FIXTURE_ROOT && !isDescendant(FIXTURE_ROOT, canonical)) {
        fail(`${label} parent resolves outside the disposable fixture root`)
      }
      return
    }
    ancestor = path.dirname(ancestor)
  }
  fail(`${label} has no existing parent below the disposable fixture root`)
}

async function assertFixtureGuard() {
  if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
    fail("DIGITAL_DOWNLOADS_E2E=1 is required to modify the disposable fixture")
  }
  if (process.env.E2E_BACKEND_URL !== "http://127.0.0.1:9100") {
    fail("E2E_BACKEND_URL must be the isolated fixture URL http://127.0.0.1:9100")
  }
  const canonicalFixture = await realpath(FIXTURE_ROOT).catch(() => undefined)
  if (!canonicalFixture) fail("E2E_FIXTURE_ROOT does not exist")
  const protectedPaths = new Set([
    path.parse(canonicalFixture).root,
    path.resolve(homedir()),
    REPOSITORY_ROOT,
    "/Users",
    "/home",
    "/tmp",
    "/var",
    "/Volumes",
  ])
  if (protectedPaths.has(canonicalFixture)) {
    fail("E2E_FIXTURE_ROOT is too broad or points at a protected working directory")
  }
  await assertExistingDescendant(APP_ROOT, "Medusa fixture")
  await assertExistingDescendant(BACKEND_ROOT, "backend fixture")
  await assertExistingDescendant(CONFIG_PATH, "backend config")
  await assertWritableDescendant(
    NOTIFICATION_PROVIDER_INDEX_PATH,
    "fixture notification provider index",
  )
  await assertWritableDescendant(
    NOTIFICATION_PROVIDER_SERVICE_PATH,
    "fixture notification provider service",
  )
  if (!SKIP_STOREFRONT) {
    await assertExistingDescendant(STOREFRONT_ROOT, "storefront fixture")
    await assertWritableDescendant(
      STOREFRONT_CONSUMER_PATH,
      "fixture storefront consumer",
    )
    await assertWritableDescendant(
      STOREFRONT_CLIENT_PATH,
      "fixture storefront client",
    )
    await assertWritableDescendant(
      STOREFRONT_STYLES_PATH,
      "fixture storefront styles",
    )
    await assertWritableDescendant(
      STOREFRONT_EMAIL_PREVIEW_PATH,
      "fixture storefront email preview",
    )
  }
  await assertWritableDescendant(BACKUP_ROOT, "fixture backup directory")
  await assertWritableDescendant(RUNTIME_ROOT, "fixture runtime directory")
  const marker = await readFile(path.join(APP_ROOT, "FIXTURE.md"), "utf8").catch(
    () => "",
  )
  if (!marker.includes("Digital Downloads E2E Fixture")) {
    fail("E2E_FIXTURE_ROOT does not contain the expected disposable fixture marker")
  }
}

async function validateTarball(input) {
  const absolute = path.resolve(input)
  const info = await stat(absolute).catch(() => undefined)
  if (!info?.isFile() || !absolute.endsWith(".tgz")) {
    fail("The packed plugin must be an existing .tgz file")
  }

  const entries = execFileSync("tar", ["-tzf", absolute], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
  if (!entries.length) fail("The plugin tarball is empty")
  for (const entry of entries) {
    if (
      !entry.startsWith("package/") ||
      entry.startsWith("/") ||
      entry.split("/").some((segment) => segment === "..")
    ) {
      fail(`Unsafe archive entry rejected: ${entry.slice(0, 160)}`)
    }
  }

  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOzf", absolute, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  )
  if (packageJson.name !== PLUGIN_NAME) {
    fail(`Expected package ${PLUGIN_NAME}, received ${String(packageJson.name)}`)
  }
  if (packageJson.version !== EXPECTED_VERSION) {
    fail(
      `Expected packed version ${EXPECTED_VERSION}, received ${String(packageJson.version)}`,
    )
  }

  const bytes = await readFile(absolute)
  return {
    absolute,
    name: packageJson.name,
    version: packageJson.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function stageTarball(metadata) {
  const artifactsRoot = path.join(RUNTIME_ROOT, "artifacts")
  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 })
  await assertExistingDescendant(artifactsRoot, "fixture artifact directory")
  await chmod(artifactsRoot, 0o700)
  const staged = path.join(
    artifactsRoot,
    `medusa-plugin-digital-downloads-${metadata.sha256}.tgz`,
  )
  const bytes = await readFile(metadata.absolute)
  try {
    await writeFile(staged, bytes, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const existing = await lstat(staged)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail("The staged packed artifact must be a regular, non-symlink file")
    }
    await assertExistingDescendant(staged, "staged packed artifact")
    const existingHash = createHash("sha256")
      .update(await readFile(staged))
      .digest("hex")
    if (existingHash !== metadata.sha256) {
      fail("The staged packed artifact does not match its content-addressed path")
    }
  }
  return staged
}

async function backupOriginalConfig() {
  await mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 })
  await chmod(BACKUP_ROOT, 0o700)
  const backup = path.join(BACKUP_ROOT, "medusa-config.ts.original")
  try {
    await stat(backup)
  } catch {
    await writeFile(backup, await readFile(CONFIG_PATH), {
      mode: 0o600,
      flag: "wx",
    })
  }
}

function generatedConfig() {
  return `import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(\`Missing fixture environment variable \${name}\`)
  return value
}

if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
  throw new Error("This generated config is restricted to the disposable digital-downloads fixture")
}

const storageProvider =
  process.env.DIGITAL_DOWNLOADS_E2E_STORAGE_PROVIDER === "s3" ? "s3" : "local"

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: required("DATABASE_URL"),
    // The disposable fixture is deliberately served on fixed loopback HTTP
    // ports while using Medusa's production build. Override the production
    // Secure-cookie default only for this guarded, localhost-only harness so
    // a real browser can exercise the authenticated Admin extension.
    cookieOptions: {
      secure: false,
      sameSite: "lax",
    },
    http: {
      storeCors: required("STORE_CORS"),
      adminCors: required("ADMIN_CORS"),
      authCors: required("AUTH_CORS"),
      jwtSecret: required("JWT_SECRET"),
      cookieSecret: required("COOKIE_SECRET"),
    },
  },
  modules: [
    {
      resolve: "@medusajs/medusa/notification",
      options: {
        providers: [
          {
            resolve: "./src/modules/digital-downloads-e2e-notification",
            id: "digital-downloads-e2e",
            options: {
              name: "Digital Downloads E2E Capture Provider",
              channels: ["email"],
              captureRoot: required("E2E_NOTIFICATION_CAPTURE_ROOT"),
              fixtureRoot: required("E2E_FIXTURE_ROOT"),
              failOnceRecipientFragment: "-showcase-retry@",
            },
          },
        ],
      },
    },
  ],
  plugins: [
    {
      resolve: "${PLUGIN_NAME}",
      options: {
        tokenSecret: required("DIGITAL_DOWNLOADS_TOKEN_SECRET"),
        encryptionKey: required("DIGITAL_DOWNLOADS_ENCRYPTION_KEY"),
        defaultDownloadLimit: 2,
        defaultGrantTtlSeconds: 300,
        maxGrantTtlSeconds: 900,
        maxUploadSizeBytes: 64 * 1024 * 1024,
        allowGuestAccess: true,
        refundPolicy: "full_refund",
        cancellationPolicy: "all",
        allowedMimeTypes: [
          "application/pdf",
          "audio/mpeg",
          "image/png",
          "text/plain",
          "application/octet-stream",
        ],
        storage: {
          defaultProvider: storageProvider,
          local: {
            rootPath: required("DIGITAL_DOWNLOADS_LOCAL_ROOT"),
            signingSecret: required("DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET"),
          },
          s3: {
            endpoint: required("DIGITAL_DOWNLOADS_S3_ENDPOINT"),
            region: required("DIGITAL_DOWNLOADS_S3_REGION"),
            bucket: required("DIGITAL_DOWNLOADS_S3_BUCKET"),
            accessKeyId: required("DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID"),
            secretAccessKey: required("DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY"),
            prefix: required("DIGITAL_DOWNLOADS_S3_PREFIX"),
            forcePathStyle: true,
            allowInsecureEndpoint: true,
          },
        },
      },
    },
  ],
})
`
}

async function installTarball(tarball) {
  const consumerRoots = SKIP_STOREFRONT
    ? [BACKEND_ROOT]
    : [BACKEND_ROOT, STOREFRONT_ROOT]
  const installEnvironment = { ...process.env }
  for (const key of Object.keys(installEnvironment)) {
    if (
      /^(?:DATABASE_URL|JWT_SECRET|COOKIE_SECRET|E2E_ADMIN_PASSWORD|DIGITAL_DOWNLOADS_.*(?:SECRET|KEY)|MINIO_ROOT_PASSWORD)$/i.test(
        key,
      )
    ) {
      delete installEnvironment[key]
    }
  }
  for (const consumerRoot of consumerRoots) {
    const result = spawnSync(
      "pnpm",
      [
        "--dir",
        consumerRoot,
        "add",
        "--save-exact",
        "--ignore-scripts",
        "--prefer-offline",
        tarball,
      ],
      { stdio: "inherit", env: installEnvironment },
    )
    if (result.status !== 0) {
      fail(
        `pnpm failed to install the packed plugin in ${path.basename(consumerRoot)} (exit ${String(result.status)})`,
      )
    }
  }

  const requireFromBackend = createRequire(path.join(BACKEND_ROOT, "package.json"))
  const installed = requireFromBackend(`${PLUGIN_NAME}/package.json`)
  if (installed.version !== EXPECTED_VERSION) {
    fail(`Installed plugin version is ${String(installed.version)}, not ${EXPECTED_VERSION}`)
  }
  if (!SKIP_STOREFRONT) {
    const requireFromStorefront = createRequire(
      path.join(STOREFRONT_ROOT, "package.json"),
    )
    const storefrontInstalled = requireFromStorefront(`${PLUGIN_NAME}/package.json`)
    const storefrontExports = requireFromStorefront(`${PLUGIN_NAME}/storefront`)
    if (
      storefrontInstalled.version !== EXPECTED_VERSION ||
      typeof storefrontExports.createDigitalDownloadsFetchClient !== "function" ||
      typeof storefrontExports.MakePayAttribution !== "function"
    ) {
      fail(`The packed storefront export is missing or does not match v${EXPECTED_VERSION}`)
    }
  }
}

function generatedNotificationProviderIndex() {
  return `/* ${GENERATED_MARKER} */
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import DigitalDownloadsE2ENotificationProvider from "./service"

export default ModuleProvider(Modules.NOTIFICATION, {
  services: [DigitalDownloadsE2ENotificationProvider],
})
`
}

function generatedNotificationProviderService() {
  return `/* ${GENERATED_MARKER} */
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import type { NotificationTypes } from "@medusajs/framework/types"
import {
  AbstractNotificationProviderService,
  MedusaError,
} from "@medusajs/framework/utils"

type ProviderOptions = {
  captureRoot: string
  fixtureRoot: string
  failOnceRecipientFragment?: string
}

type JsonRecord = Record<string, unknown>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const CAPABILITY_KEY = /token|license_key|authorization|password|secret|credential/i

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function safeText(value: unknown, fallback: string, limit = 300): string {
  if (typeof value !== "string") return fallback
  const normalized = value.replace(/[\\u0000-\\u001f\\u007f]/g, " ").trim()
  return normalized ? normalized.slice(0, limit) : fallback
}

function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (!isRecord(value)) return value
  const output: JsonRecord = {}
  for (const [key, child] of Object.entries(value)) {
    output[key] = CAPABILITY_KEY.test(key) ? "[redacted]" : redacted(child)
  }
  return output
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function strictDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
}

export default class DigitalDownloadsE2ENotificationProvider extends AbstractNotificationProviderService {
  static identifier = "digital-downloads-e2e-capture"
  protected options_: ProviderOptions

  constructor(_container: unknown, options: ProviderOptions) {
    super()
    this.options_ = options
  }

  private async roots(): Promise<{ attempts: string; captures: string }> {
    if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "The fixture notification provider is disabled outside packed E2E",
      )
    }
    const fixtureRoot = await realpath(path.resolve(this.options_.fixtureRoot))
    const runtimeRoot = await realpath(path.join(fixtureRoot, "runtime"))
    const requestedCaptureRoot = path.resolve(this.options_.captureRoot)
    if (!strictDescendant(runtimeRoot, requestedCaptureRoot)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The fixture notification capture root must be below fixture runtime",
      )
    }
    await mkdir(requestedCaptureRoot, { recursive: true, mode: 0o700 })
    const captureRoot = await realpath(requestedCaptureRoot)
    if (!strictDescendant(runtimeRoot, captureRoot)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The fixture notification capture root escaped fixture runtime",
      )
    }
    await chmod(captureRoot, 0o700)
    const attempts = path.join(captureRoot, "attempts")
    const captures = path.join(captureRoot, "captures")
    await mkdir(attempts, { recursive: true, mode: 0o700 })
    await mkdir(captures, { recursive: true, mode: 0o700 })
    await chmod(attempts, 0o700)
    await chmod(captures, 0o700)
    return { attempts, captures }
  }

  async send(
    notification: NotificationTypes.ProviderSendNotificationDTO,
  ): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    if (!notification || notification.channel !== "email") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The fixture notification provider only accepts email",
      )
    }
    const data = isRecord(notification.data) ? notification.data : {}
    const entitlementId = safeText(data.entitlement_id, "", 160)
    const orderId = safeText(data.order_id, "", 160)
    const template = safeText(notification.template, "digital-downloads-message", 160)
    const recipient = safeText(notification.to, "", 320).toLowerCase()
    if (!IDENTIFIER.test(entitlementId) || !IDENTIFIER.test(orderId) || !recipient) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The fixture notification is missing its bounded purchase identity",
      )
    }

    const roots = await this.roots()
    const key = createHash("sha256")
      .update(recipient + "\\0" + template + "\\0" + entitlementId)
      .digest("hex")
    const failOnce = this.options_.failOnceRecipientFragment
    if (failOnce && recipient.includes(failOnce.toLowerCase())) {
      const markerPath = path.join(roots.attempts, key + ".failed-once.json")
      try {
        await writeFile(
          markerPath,
          JSON.stringify({
            schema_version: 1,
            entitlement_id: entitlementId,
            order_id: orderId,
            template,
            attempted_at: new Date().toISOString(),
          }) + "\\n",
          { mode: 0o600, flag: "wx" },
        )
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Fixture email provider fail-once probe",
        )
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error
        const marker = await lstat(markerPath)
        if (marker.isSymbolicLink() || !marker.isFile()) {
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            "Fixture email retry marker is unsafe",
          )
        }
        await readFile(markerPath, "utf8")
      }
    }

    const entitlement = isRecord(data.entitlement) ? data.entitlement : {}
    const product = isRecord(entitlement.digital_product)
      ? entitlement.digital_product
      : isRecord(entitlement.product)
        ? entitlement.product
        : {}
    const lineItem = isRecord(entitlement.line_item) ? entitlement.line_item : {}
    const order = isRecord(entitlement.order) ? entitlement.order : {}
    const productTitle = safeText(
      product.name ?? product.title ?? lineItem.title,
      "Your digital purchase",
    )
    const rawDisplayId = order.display_id
    const displayId =
      typeof rawDisplayId === "number" && Number.isSafeInteger(rawDisplayId)
        ? String(rawDisplayId)
        : safeText(rawDisplayId, "", 64)
    const orderLabel = displayId
      ? "#" + displayId
      : safeText(order.id ?? orderId, orderId, 160)
    const subjectByTemplate: Record<string, string> = {
      "digital-downloads-delivery": "Your digital purchase is ready",
      "digital-downloads-reissued": "Your digital access was restored",
      "digital-downloads-revoked": "Your digital access changed",
      "digital-downloads-expired": "Your digital access expired",
    }
    const subject = subjectByTemplate[template] ?? "Digital purchase update"
    const guestToken =
      typeof data.guest_access_token === "string" ? data.guest_access_token : undefined
    const body = template === "digital-downloads-delivery"
      ? "Your protected files and license are available in your customer library."
      : "Open your customer library to review the current access status."
    const renderedHtml =
      "<!doctype html><html><body>" +
      "<h1>" + escapeHtml(subject) + "</h1>" +
      "<p>" + escapeHtml(body) + "</p>" +
      "<p><strong>Product:</strong> " + escapeHtml(productTitle) + "</p>" +
      "<p><strong>Order:</strong> " + escapeHtml(orderLabel) + "</p>" +
      (guestToken
        ? "<p>A private guest access link was included in the delivered message.</p>"
        : "<p>Sign in to your account to download files or reveal your license.</p>") +
      "</body></html>"

    const externalId = "e2e-email-" + key.slice(0, 20) + "-" + randomUUID()
    const record = {
      schema_version: 1,
      provider_message_id: externalId,
      captured_at: new Date().toISOString(),
      to: recipient,
      channel: "email",
      template,
      entitlement_id: entitlementId,
      order_id: orderId,
      payload: redacted(data),
      preview: {
        subject,
        heading: subject,
        body,
        product_title: productTitle,
        order_label: orderLabel,
        access_link_included: Boolean(guestToken),
        html: renderedHtml,
      },
      secret: guestToken ? { guest_access_token: guestToken } : undefined,
    }
    const capturePath = path.join(
      roots.captures,
      key + "-" + Date.now() + "-" + randomUUID() + ".json",
    )
    const temporaryCapturePath = capturePath + "." + process.pid + ".tmp"
    await writeFile(temporaryCapturePath, JSON.stringify(record, null, 2) + "\\n", {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporaryCapturePath, capturePath)
    const stored = await lstat(capturePath)
    if (stored.isSymbolicLink() || !stored.isFile() || (stored.mode & 0o077) !== 0) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Fixture email capture permissions are unsafe",
      )
    }
    return { id: externalId }
  }
}
`
}

async function writeOwnedFixtureFile(target, contents, label, legacyMarker) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const existing = await readFile(target, "utf8").catch(() => undefined)
  if (
    existing !== undefined &&
    !existing.includes(GENERATED_MARKER) &&
    !(legacyMarker && existing.includes(legacyMarker))
  ) {
    fail(`Refusing to replace a non-fixture ${label}`)
  }
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" })
  await rename(temporary, target)
}

async function writeNotificationProvider() {
  await writeOwnedFixtureFile(
    NOTIFICATION_PROVIDER_INDEX_PATH,
    generatedNotificationProviderIndex(),
    "notification provider index",
  )
  await writeOwnedFixtureFile(
    NOTIFICATION_PROVIDER_SERVICE_PATH,
    generatedNotificationProviderService(),
    "notification provider service",
  )
}

function generatedStorefrontConsumer() {
  return `/* ${GENERATED_MARKER} */
import DigitalDownloadsE2EClient from "./client"

export const dynamic = "force-dynamic"

type PageProps = {
  searchParams: Promise<{
    order_display_id?: string
    order_id?: string
    variant_id?: string
  }>
}

export default async function DigitalDownloadsE2EPage({ searchParams }: PageProps) {
  const {
    order_display_id: requestedOrderDisplayId,
    order_id: orderId,
    variant_id: variantId,
  } = await searchParams
  const orderDisplayId = /^[0-9]{1,20}$/.test(requestedOrderDisplayId ?? "")
    ? requestedOrderDisplayId
    : undefined
  const backendUrl = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const publishableKey = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY

  if (!backendUrl || !publishableKey) {
    throw new Error("The packed storefront consumer requires its fixture environment")
  }

  return (
    <DigitalDownloadsE2EClient
      backendUrl={backendUrl}
      initialOrderDisplayId={orderDisplayId}
      initialOrderId={orderId ?? ""}
      publishableKey={publishableKey}
      variantId={variantId}
    />
  )
}
`
}

function generatedStorefrontClient() {
  return `/* ${GENERATED_MARKER} */
"use client"

import {
  DigitalDownloadsProvider,
  DigitalLibrary,
  DigitalOrderDownloads,
  DigitalProductPreviews,
  MakePayAttribution,
  createDigitalDownloadsFetchClient,
  fetchDigitalAccessGrant,
  prepareDigitalAccessGrant,
  type DigitalAccessGrant,
} from "${PLUGIN_NAME}/storefront"
import { useMemo, useState, type FormEvent } from "react"
import styles from "./page.module.css"

type Props = {
  backendUrl: string
  publishableKey: string
  initialOrderDisplayId?: string
  initialOrderId: string
  variantId?: string
}

type EmailPreview = {
  captured_at: string
  channel: string
  order_id: string
  template: string
  to: string
  preview: {
    access_link_included: boolean
    body: string
    heading: string
    html: string
    order_label: string
    product_title: string
    subject: string
  }
}

const safeMessage = (value: unknown): string =>
  value instanceof Error ? value.message : "The fixture request failed."

export default function DigitalDownloadsE2EClient({
  backendUrl,
  publishableKey,
  initialOrderDisplayId,
  initialOrderId,
  variantId,
}: Props) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState<string>()
  const [orderId, setOrderId] = useState(initialOrderId)
  const [orderDisplayId, setOrderDisplayId] = useState(initialOrderDisplayId)
  const [view, setView] = useState<"library" | "order" | "email">("library")
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [lastAction, setLastAction] = useState("Ready")
  const [emailPreview, setEmailPreview] = useState<EmailPreview>()

  const client = useMemo(
    () =>
      createDigitalDownloadsFetchClient({
        authToken: () => token,
        baseUrl: backendUrl,
        credentials: "omit",
        publishableKey,
        timeoutMs: 15_000,
      }),
    [backendUrl, publishableKey, token],
  )

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(undefined)
    try {
      const response = await fetch(new URL("/auth/customer/emailpass", backendUrl), {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const payload = (await response.json()) as { token?: unknown; message?: unknown }
      if (!response.ok || typeof payload.token !== "string") {
        throw new Error(
          typeof payload.message === "string" ? payload.message : "Unable to sign in.",
        )
      }
      setToken(payload.token)
      setPassword("")
      setLastAction("Signed in. Your protected purchases are ready.")
    } catch (failure) {
      setToken(undefined)
      setError(safeMessage(failure))
    } finally {
      setPending(false)
    }
  }

  const openGrant = async (grant: DigitalAccessGrant) => {
    setError(undefined)
    const resolvedGrant = {
      ...grant,
      url: new URL(grant.url, backendUrl).toString(),
    }
    try {
      const response = await fetchDigitalAccessGrant(resolvedGrant)
      const prepared = await prepareDigitalAccessGrant(resolvedGrant, response)
      const objectUrl = URL.createObjectURL(prepared.blob)
      const link = document.createElement("a")
      link.href = objectUrl
      link.rel = "noopener noreferrer"
      if (prepared.openInline) {
        link.target = "_blank"
      } else {
        link.download = grant.filename?.trim() || "digital-download"
      }
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000)
      setLastAction(
        (prepared.openInline ? "Protected stream opened: " : "Protected download completed: ") +
          prepared.size + " bytes received.",
      )
    } catch (failure) {
      setError(safeMessage(failure))
      throw failure
    }
  }

  const loadEmail = async () => {
    if (!orderId) {
      setError("Enter the Medusa order ID before opening its delivery email.")
      return
    }
    setPending(true)
    setError(undefined)
    try {
      const response = await fetch(
        "/api/digital-downloads-e2e/email-preview?order_id=" + encodeURIComponent(orderId),
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { authorization: "Bearer " + token },
        },
      )
      const payload = (await response.json()) as EmailPreview & { message?: string }
      if (!response.ok) throw new Error(payload.message ?? "Delivery email is not ready.")
      setEmailPreview(payload)
      setView("email")
      setLastAction("Sanitized delivery email opened.")
    } catch (failure) {
      setError(safeMessage(failure))
    } finally {
      setPending(false)
    }
  }

  const signOut = () => {
    setToken(undefined)
    setPassword("")
    setEmailPreview(undefined)
    setLastAction("Signed out. Credentials and bearer token were cleared from memory.")
  }

  return (
    <main className={styles.shell} data-packed-digital-downloads-storefront="v2">
      <header className={styles.hero}>
        <span className={styles.eyebrow}>Medusa customer delivery</span>
        <h1>Your downloads and licenses</h1>
        <p>
          Sign in after checkout to download files, stream media, and reveal the
          license assigned to this purchase.
        </p>
        <MakePayAttribution />
      </header>

      {variantId ? (
        <section className={styles.preview} data-testid="product-preview">
          <DigitalDownloadsProvider client={client}>
            <DigitalProductPreviews
              heading="Included digital formats"
              showAttribution={false}
              variantId={variantId}
            />
          </DigitalDownloadsProvider>
        </section>
      ) : null}

      {!token ? (
        <form className={styles.login} data-testid="customer-login" onSubmit={login}>
          <div>
            <span className={styles.eyebrow}>Customer account</span>
            <h2>Open your purchase</h2>
            <p>The disposable fixture keeps credentials and bearer tokens in memory only.</p>
          </div>
          <label>
            Email
            <input
              autoComplete="email"
              data-testid="customer-email"
              maxLength={320}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              data-testid="customer-password"
              maxLength={512}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <label>
            Order ID
            <input
              data-testid="customer-order-id"
              maxLength={160}
              onChange={(event) => {
                setOrderId(event.currentTarget.value)
                setOrderDisplayId(undefined)
              }}
              placeholder="order_..."
              required
              value={orderId}
            />
          </label>
          <button disabled={pending} type="submit">
            {pending ? "Signing in…" : "Sign in securely"}
          </button>
        </form>
      ) : (
        <DigitalDownloadsProvider client={client} identityKey={email.trim().toLowerCase()}>
          <section className={styles.account} data-testid="customer-delivery-account">
            <div className={styles.accountHeader}>
              <div>
                <span className={styles.eyebrow}>Signed in</span>
                <h2>Digital purchase center</h2>
                <p>{email.trim().toLowerCase()}</p>
              </div>
              <button className={styles.secondaryButton} onClick={signOut} type="button">
                Sign out
              </button>
            </div>

            <nav aria-label="Digital purchase views" className={styles.tabs}>
              <button
                aria-pressed={view === "library"}
                data-testid="library-tab"
                onClick={() => setView("library")}
                type="button"
              >
                My library
              </button>
              <button
                aria-pressed={view === "order"}
                data-testid="order-history-tab"
                onClick={() => setView("order")}
                type="button"
              >
                Order history
              </button>
              <button
                aria-pressed={view === "email"}
                data-testid="delivery-email-tab"
                disabled={pending}
                onClick={() => void loadEmail()}
                type="button"
              >
                Delivery email
              </button>
            </nav>

            {view === "library" ? (
              <div className={styles.library} data-testid="customer-library-view">
                <DigitalLibrary
                  heading="Your digital library"
                  onGrant={openGrant}
                  onLicenseRevealed={() => setLastAction("Disposable license revealed.")}
                  query={{ limit: 20 }}
                  showAttribution={false}
                />
              </div>
            ) : null}

            {view === "order" ? (
              <div className={styles.orderView} data-testid="customer-order-history-view">
                <div className={styles.orderHeading}>
                  <div>
                    <span className={styles.eyebrow}>Medusa order history</span>
                    <h3>Downloads for this order</h3>
                  </div>
                  <code>{orderDisplayId ? "#" + orderDisplayId : orderId}</code>
                </div>
                <div className={styles.library}>
                  <DigitalOrderDownloads
                    empty="This order does not contain an accessible digital purchase."
                    heading="Order downloads and license"
                    onGrant={openGrant}
                    onLicenseRevealed={() => setLastAction("Disposable license revealed.")}
                    orderDisplayId={orderDisplayId}
                    orderId={orderId}
                    query={{ limit: 20 }}
                    showAttribution={false}
                  />
                </div>
              </div>
            ) : null}

            {view === "email" && emailPreview ? (
              <article className={styles.email} data-testid="delivery-email-preview">
                <span className={styles.eyebrow}>Automated email · {emailPreview.channel}</span>
                <h3>{emailPreview.preview.heading}</h3>
                <p className={styles.subject}>Subject: {emailPreview.preview.subject}</p>
                <iframe
                  className={styles.emailFrame}
                  sandbox=""
                  srcDoc={emailPreview.preview.html}
                  title="Captured digital delivery email"
                />
                <dl>
                  <div><dt>Product</dt><dd>{emailPreview.preview.product_title}</dd></div>
                  <div><dt>Order</dt><dd>{emailPreview.preview.order_label}</dd></div>
                  <div><dt>Template</dt><dd>{emailPreview.template}</dd></div>
                  <div><dt>Recipient</dt><dd>Verified order email</dd></div>
                </dl>
                <p className={styles.safeNotice}>
                  This preview is sanitized. Guest capabilities and license keys are never exposed here.
                </p>
              </article>
            ) : null}
          </section>
        </DigitalDownloadsProvider>
      )}

      <p
        aria-live="polite"
        className={error ? styles.error : styles.status}
        data-testid="customer-delivery-status"
        role={error ? "alert" : "status"}
      >
        {error ?? lastAction}
      </p>
    </main>
  )
}
`
}

function generatedStorefrontStyles() {
  return `/* ${GENERATED_MARKER} */
.shell {
  --ink: #111827;
  --muted: #64748b;
  --line: #dbe4ee;
  --brand: #0f766e;
  background: #f5f7fb;
  color: var(--ink);
  min-height: 100vh;
  padding: 48px max(24px, calc((100vw - 1120px) / 2));
}
.hero, .login, .account, .preview, .status, .error {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 14px 40px rgba(15, 23, 42, .06);
}
.hero { padding: 38px; }
.hero h1 { font-size: clamp(2rem, 4vw, 3.7rem); letter-spacing: -.045em; line-height: 1; margin: 12px 0 18px; }
.hero p { color: var(--muted); font-size: 1.05rem; max-width: 720px; }
.eyebrow { color: var(--brand); font-size: .75rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.preview, .login, .account { margin-top: 24px; padding: 30px; }
.login { display: grid; gap: 18px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.login > div { grid-column: 1 / -1; }
.login label { color: #334155; display: grid; font-size: .85rem; font-weight: 650; gap: 8px; }
.login input { border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; min-height: 44px; padding: 10px 12px; }
.login button, .tabs button, .secondaryButton { border: 0; border-radius: 10px; cursor: pointer; font-weight: 700; min-height: 42px; padding: 10px 16px; }
.login button { align-self: end; background: var(--brand); color: #fff; }
.accountHeader, .orderHeading { align-items: center; display: flex; justify-content: space-between; gap: 24px; }
.secondaryButton { background: #e2e8f0; color: #0f172a; }
.tabs { display: flex; gap: 8px; margin: 28px 0 22px; }
.tabs button { background: #eef2f7; color: #334155; }
.tabs button[aria-pressed="true"] { background: #0f172a; color: #fff; }
.library :global([data-digital-library]) > header { align-items: center; display: flex; justify-content: space-between; margin-bottom: 18px; }
.library :global([data-digital-library]) > ul { display: grid; gap: 18px; list-style: none; margin: 0; padding: 0; }
.library :global([data-digital-entitlement]) { background: #f8fafc; border: 1px solid var(--line); border-radius: 14px; display: grid; gap: 18px; padding: 22px; }
.library :global([data-digital-entitlement] > header) { align-items: center; display: flex; gap: 16px; }
.library :global([data-digital-entitlement] > header > span) { background: #dcfce7; border-radius: 999px; color: #166534; margin-left: auto; padding: 5px 10px; }
.library :global(dl) { display: flex; flex-wrap: wrap; gap: 14px 28px; }
.library :global(dt) { color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.library :global(dd) { margin: 3px 0 0; }
.library :global(ul) { list-style: none; margin: 0; padding: 0; }
.library :global(li) { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 10px; justify-content: space-between; padding: 12px 0; }
.library :global(button) { background: var(--brand); border: 0; border-radius: 9px; color: #fff; cursor: pointer; font-weight: 700; padding: 8px 12px; }
.library :global(code) { background: #e2e8f0; border-radius: 6px; padding: 4px 7px; }
.orderView, .email { background: #f8fafc; border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
.orderHeading { margin-bottom: 22px; }
.orderHeading code { background: #e2e8f0; border-radius: 8px; padding: 8px 10px; }
.email { max-width: 760px; }
.email h3 { font-size: 1.8rem; margin: 12px 0; }
.subject { border-bottom: 1px solid var(--line); color: #334155; padding-bottom: 16px; }
.emailFrame { background: #fff; border: 1px solid var(--line); border-radius: 12px; min-height: 310px; width: 100%; }
.email dl { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.email dt { color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.email dd { margin: 3px 0 0; }
.safeNotice { background: #ecfdf5; border-radius: 10px; color: #166534; padding: 12px; }
.status, .error { margin-top: 24px; padding: 16px 20px; }
.status { color: #166534; }
.error { color: #b91c1c; }
@media (max-width: 760px) {
  .shell { padding: 24px 14px; }
  .login { grid-template-columns: 1fr; }
  .accountHeader, .orderHeading { align-items: flex-start; flex-direction: column; }
  .tabs { align-items: stretch; flex-direction: column; }
  .email dl { grid-template-columns: 1fr; }
}
`
}

function generatedEmailPreviewRoute() {
  return `/* ${GENERATED_MARKER} */
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const CAPABILITY = /(?:dda|ddg|ddu)_[A-Za-z0-9._~-]+|guest_access_token|license_key/i

function strictDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return Boolean(relative) && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

export async function GET(request: NextRequest): Promise<Response> {
  if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
    return Response.json({ message: "Not found." }, { status: 404 })
  }
  const orderId = request.nextUrl.searchParams.get("order_id") ?? ""
  if (!IDENTIFIER.test(orderId)) {
    return Response.json({ message: "A valid fixture order ID is required." }, { status: 400 })
  }
  const fixtureInput = process.env.E2E_FIXTURE_ROOT
  const captureInput = process.env.E2E_NOTIFICATION_CAPTURE_ROOT
  const backendInput = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const publishableKey = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
  const authorization = request.headers.get("authorization") ?? ""
  if (
    !fixtureInput || !captureInput || !path.isAbsolute(fixtureInput) ||
    !path.isAbsolute(captureInput) || !backendInput || !publishableKey ||
    !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
  ) {
    return Response.json({ message: "Authentication is required." }, { status: 401 })
  }
  const backendUrl = new URL(backendInput)
  if (
    backendUrl.protocol !== "http:" || backendUrl.hostname !== "127.0.0.1" ||
    backendUrl.port !== "9100" || backendUrl.pathname !== "/"
  ) {
    return Response.json({ message: "Email preview is not configured." }, { status: 500 })
  }
  try {
    const libraryUrl = new URL("/store/digital-downloads/library", backendUrl)
    libraryUrl.searchParams.set("limit", "100")
    libraryUrl.searchParams.set("order_id", orderId)
    const libraryResponse = await fetch(libraryUrl, {
      cache: "no-store",
      headers: {
        authorization,
        "x-publishable-api-key": publishableKey,
      },
    })
    const libraryPayload = record(await libraryResponse.json().catch(() => ({})))
    if (
      libraryResponse.status === 401 || libraryResponse.status === 403 ||
      !Array.isArray(libraryPayload.entitlements) || !libraryPayload.entitlements.length
    ) {
      return Response.json({ message: "This order is not available to the signed-in customer." }, { status: 404 })
    }
    if (!libraryResponse.ok) {
      throw new Error("customer authorization probe failed")
    }
    const authorizedEntitlementIds = new Set(
      libraryPayload.entitlements
        .map((entitlement: unknown) => record(entitlement).id)
        .filter((id: unknown): id is string => typeof id === "string"),
    )
    const fixtureRoot = await realpath(path.resolve(fixtureInput))
    const runtimeRoot = await realpath(path.join(fixtureRoot, "runtime"))
    const captureRoot = await realpath(path.join(path.resolve(captureInput), "captures"))
    if (!strictDescendant(runtimeRoot, captureRoot)) {
      throw new Error("capture root escaped runtime")
    }
    const names = (await readdir(captureRoot))
      .filter((name) => /^[a-f0-9-]+\\.json$/.test(name))
      .slice(-200)
    const matches: Record<string, any>[] = []
    for (const name of names) {
      const candidate = path.join(captureRoot, name)
      const canonical = await realpath(candidate)
      if (!strictDescendant(captureRoot, canonical)) continue
      const info = await lstat(canonical)
      if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024 || (info.mode & 0o077) !== 0) continue
      const parsed = record(JSON.parse(await readFile(canonical, "utf8")))
      if (
        parsed.order_id === orderId &&
        authorizedEntitlementIds.has(parsed.entitlement_id) &&
        record(parsed.preview).subject
      ) matches.push(parsed)
    }
    const selected = matches.sort((left, right) =>
      String(left.captured_at).localeCompare(String(right.captured_at)),
    ).at(-1)
    if (!selected) {
      return Response.json({ message: "Delivery email is not ready." }, { status: 404 })
    }
    const preview = record(selected.preview)
    const response = {
      captured_at: selected.captured_at,
      channel: selected.channel,
      order_id: selected.order_id,
      template: selected.template,
      to: selected.to,
      preview: {
        access_link_included: Boolean(preview.access_link_included),
        body: preview.body,
        heading: preview.heading,
        html: preview.html,
        order_label: preview.order_label,
        product_title: preview.product_title,
        subject: preview.subject,
      },
    }
    if (
      typeof response.preview.html !== "string" ||
      response.preview.html.length < 32 ||
      response.preview.html.length > 64 * 1024 ||
      !/^<!doctype html><html><body>[\\s\\S]*<\\/body><\\/html>$/.test(response.preview.html) ||
      /<(?!\\/?(?:html|body|h1|p|strong)>|!doctype html>)[^>]+>/i.test(response.preview.html) ||
      CAPABILITY.test(JSON.stringify(response))
    ) {
      throw new Error("sanitized email response contains unsafe content")
    }
    return Response.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    })
  } catch {
    return Response.json({ message: "Unable to load the sanitized email preview." }, { status: 500 })
  }
}
`
}

async function writeStorefrontConsumer() {
  await writeOwnedFixtureFile(
    STOREFRONT_CONSUMER_PATH,
    generatedStorefrontConsumer(),
    "storefront route",
    'data-packed-digital-downloads-storefront="v1"',
  )
  await writeOwnedFixtureFile(
    STOREFRONT_CLIENT_PATH,
    generatedStorefrontClient(),
    "storefront client",
  )
  await writeOwnedFixtureFile(
    STOREFRONT_STYLES_PATH,
    generatedStorefrontStyles(),
    "storefront styles",
  )
  await writeOwnedFixtureFile(
    STOREFRONT_EMAIL_PREVIEW_PATH,
    generatedEmailPreviewRoute(),
    "storefront email preview route",
  )
}

async function writeFixtureConfig() {
  await backupOriginalConfig()
  const temporary = `${CONFIG_PATH}.e2e-${process.pid}.tmp`
  await writeFile(temporary, generatedConfig(), { mode: 0o600, flag: "wx" })
  await rename(temporary, CONFIG_PATH)
}

async function writeReceipt(metadata) {
  await mkdir(RUNTIME_ROOT, { recursive: true, mode: 0o700 })
  await chmod(RUNTIME_ROOT, 0o700)
  const receiptPath = path.join(RUNTIME_ROOT, "installed-artifact.json")
  const temporary = `${receiptPath}.${process.pid}.tmp`
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        package: metadata.name,
        version: metadata.version,
        sha256: metadata.sha256,
        installed_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  )
  await rename(temporary, receiptPath)
}

async function main() {
  await assertFixtureGuard()
  const tarball = process.argv[2]
  if (!tarball) fail("Usage: configure-fixture.mjs /absolute/path/to/package.tgz")
  const metadata = await validateTarball(tarball)
  const stagedTarball = await stageTarball(metadata)
  await installTarball(stagedTarball)
  await writeNotificationProvider()
  await writeFixtureConfig()
  if (!SKIP_STOREFRONT) await writeStorefrontConsumer()
  await writeReceipt(metadata)
  process.stdout.write(
    `Configured disposable fixture with ${metadata.name}@${metadata.version} (${metadata.sha256.slice(0, 12)}…)\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`Fixture configuration failed: ${error.message}\n`)
  process.exitCode = 1
})
