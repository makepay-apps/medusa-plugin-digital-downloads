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
const EXPECTED_VERSION = "0.3.0"
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
const STOREFRONT_CONSUMER_PATH = path.join(
  STOREFRONT_ROOT,
  "src/app/[countryCode]/(main)/digital-downloads-e2e/page.tsx",
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
  if (!SKIP_STOREFRONT) {
    await assertExistingDescendant(STOREFRONT_ROOT, "storefront fixture")
    await assertWritableDescendant(
      STOREFRONT_CONSUMER_PATH,
      "fixture storefront consumer",
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
      fail("The packed storefront export is missing or does not match v0.3.0")
    }
  }
}

function generatedStorefrontConsumer() {
  return `import {
  MakePayAttribution,
  createDigitalDownloadsFetchClient,
} from "${PLUGIN_NAME}/storefront"

export const dynamic = "force-dynamic"

type PageProps = {
  searchParams: Promise<{ variant_id?: string }>
}

export default async function DigitalDownloadsE2EPage({ searchParams }: PageProps) {
  const { variant_id: variantId } = await searchParams
  const backendUrl = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const publishableKey = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY

  if (!variantId || !backendUrl || !publishableKey) {
    throw new Error("The packed storefront consumer requires its fixture environment and variant_id")
  }

  const client = createDigitalDownloadsFetchClient({
    baseUrl: backendUrl,
    publishableKey,
  })
  const { product } = await client.getProductPreview(variantId, {
    cache: "no-store",
  })

  return (
    <main data-packed-digital-downloads-storefront="v1">
      <h1>Digital product delivery</h1>
      <p data-digital-variant-id>{product.variant_id}</p>
      <p data-digital-delivery-types>{[...product.delivery_types].sort().join(",")}</p>
      <MakePayAttribution />
    </main>
  )
}
`
}

async function writeStorefrontConsumer() {
  await mkdir(path.dirname(STOREFRONT_CONSUMER_PATH), {
    recursive: true,
    mode: 0o700,
  })
  const existing = await readFile(STOREFRONT_CONSUMER_PATH, "utf8").catch(
    () => undefined,
  )
  if (
    existing !== undefined &&
    !existing.includes('data-packed-digital-downloads-storefront="v1"')
  ) {
    fail("Refusing to replace a non-fixture storefront route")
  }
  const temporary = `${STOREFRONT_CONSUMER_PATH}.${process.pid}.tmp`
  await writeFile(temporary, generatedStorefrontConsumer(), {
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, STOREFRONT_CONSUMER_PATH)
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
