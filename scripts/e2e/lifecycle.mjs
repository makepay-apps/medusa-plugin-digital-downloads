#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
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
const RUNTIME_ROOT = path.join(FIXTURE_ROOT, "runtime")
const BASE_URL = new URL(required("E2E_BACKEND_URL"))
const RUN_ID = safeSlug(required("E2E_RUN_ID"))
const STORAGE_PROVIDER = required("DIGITAL_DOWNLOADS_E2E_STORAGE_PROVIDER")
const PUBLISHABLE_KEY = required("E2E_PUBLISHABLE_KEY")
const ADMIN_EMAIL = required("E2E_ADMIN_EMAIL")
const ADMIN_PASSWORD = required("E2E_ADMIN_PASSWORD")
const BRIDGE_SCRIPT = path.resolve(required("E2E_BRIDGE_SCRIPT"))
const RESULT_PATH = path.resolve(required("E2E_RESULT_PATH"))
const USER_AGENT = "makepay-digital-downloads-packed-e2e/1.0"

if (
  process.env.DIGITAL_DOWNLOADS_E2E !== "1" ||
  BASE_URL.protocol !== "http:" ||
  BASE_URL.hostname !== "127.0.0.1" ||
  BASE_URL.port !== "9100" ||
  BASE_URL.pathname !== "/"
) {
  throw new Error("The lifecycle runner is restricted to http://127.0.0.1:9100")
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
if (!["local", "s3"].includes(STORAGE_PROVIDER)) {
  throw new Error("DIGITAL_DOWNLOADS_E2E_STORAGE_PROVIDER must be local or s3")
}
const relativeResultPath = path.relative(RUNTIME_ROOT, RESULT_PATH)
if (
  !relativeResultPath ||
  relativeResultPath === ".." ||
  relativeResultPath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativeResultPath)
) {
  throw new Error("E2E_RESULT_PATH must be below the private fixture runtime directory")
}

const evidence = {
  schema_version: 1,
  run_id: RUN_ID,
  storage_provider: STORAGE_PROVIDER,
  started_at: new Date().toISOString(),
  status: "running",
  steps: [],
  resources: {},
  assertions: {},
}

let adminToken
let customerAToken
let customerBToken

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing fixture environment variable ${name}`)
  return value
}

function safeSlug(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!result || result.length > 80) throw new Error("E2E_RUN_ID is invalid")
  return result
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== "object") return value
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (/token|license_key|authorization|password|secret|credential|storage_key|object_key/i.test(key)) {
      output[key] = "[redacted]"
    } else {
      output[key] = redacted(child)
    }
  }
  return output
}

function redactedText(value) {
  let output = String(value ?? "")
  for (const secret of [
    ADMIN_PASSWORD,
    PUBLISHABLE_KEY,
    process.env.DIGITAL_DOWNLOADS_TOKEN_SECRET,
    process.env.DIGITAL_DOWNLOADS_ENCRYPTION_KEY,
    process.env.DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET,
    process.env.DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID,
    process.env.DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY,
  ]) {
    if (secret) output = output.split(secret).join("[redacted]")
  }
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(?:dda|ddg|ddu)_[A-Za-z0-9._~-]+/g, "[redacted-capability]")
    .slice(-4000)
}

function expectedStatuses(expected) {
  return Array.isArray(expected) ? expected : [expected ?? 200]
}

function fixtureUrl(resourcePath) {
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("/")) {
    throw new Error("Fixture HTTP paths must be root-relative")
  }
  const url = new URL(resourcePath, BASE_URL)
  if (url.origin !== BASE_URL.origin) throw new Error("Cross-origin fixture request rejected")
  return url
}

async function api(resourcePath, options = {}) {
  const headers = new Headers(options.headers ?? {})
  headers.set("accept", options.responseType === "bytes" ? "*/*" : "application/json")
  headers.set("user-agent", USER_AGENT)
  if (options.admin) headers.set("authorization", `Bearer ${adminToken}`)
  if (options.customer) headers.set("authorization", `Bearer ${options.customer}`)
  if (options.store) headers.set("x-publishable-api-key", PUBLISHABLE_KEY)

  let body = options.body
  if (options.json !== undefined) {
    headers.set("content-type", "application/json")
    body = JSON.stringify(options.json)
  }
  const response = await fetch(fixtureUrl(resourcePath), {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    redirect: "manual",
  })
  const allowed = expectedStatuses(options.expected)
  let data
  if (options.responseType === "bytes") {
    data = Buffer.from(await response.arrayBuffer())
  } else if (response.status !== 204) {
    const text = await response.text()
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { message: text.slice(0, 1000) }
      }
    }
  }
  if (!allowed.includes(response.status)) {
    throw new Error(
      `${options.method ?? (body === undefined ? "GET" : "POST")} ${resourcePath} returned ${response.status}; expected ${allowed.join(", ")}: ${JSON.stringify(redacted(data))}`,
    )
  }
  return { status: response.status, data, headers: response.headers }
}

async function externalPut(urlString, headers, bytes, expected = 200) {
  const url = new URL(urlString)
  assert(url.hostname === "127.0.0.1" && url.port === "9400", "S3 upload URL must target fixture MinIO")
  const response = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "user-agent": USER_AGENT },
    body: bytes,
    redirect: "manual",
  })
  const body = await response.text()
  if (!expectedStatuses(expected).includes(response.status)) {
    throw new Error(`MinIO PUT returned ${response.status}: ${redactedText(body)}`)
  }
  return response
}

async function step(name, operation) {
  const started = Date.now()
  process.stdout.write(`[packed-e2e] ${name}\n`)
  try {
    const result = await operation()
    evidence.steps.push({ name, status: "passed", duration_ms: Date.now() - started })
    return result
  } catch (error) {
    evidence.steps.push({
      name,
      status: "failed",
      duration_ms: Date.now() - started,
      error: redactedText(error?.message ?? error),
    })
    throw error
  }
}

async function poll(description, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await operation()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(redacted(last))}`)
}

function assertPrivate(headers) {
  assert(headers.get("cache-control")?.includes("no-store"), "response must be private/no-store")
  assert(headers.get("x-content-type-options") === "nosniff", "response must set nosniff")
}

async function authenticateAdmin() {
  const response = await api("/auth/user/emailpass", {
    method: "POST",
    json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    expected: [200, 201],
  })
  adminToken = record(response.data).token
  assert(typeof adminToken === "string" && adminToken.length > 32, "admin login must return a bearer token")
}

async function registerCustomer(label) {
  const email = `${RUN_ID}-${label}@digital-downloads.local`
  const password = `E2E-${RUN_ID}-${label}-Password!42`
  const registration = await api("/auth/customer/emailpass/register", {
    method: "POST",
    json: { email, password },
    expected: [200, 201],
  })
  const registrationToken = record(registration.data).token
  assert(typeof registrationToken === "string", "customer registration must return a token")
  await api("/store/customers", {
    method: "POST",
    store: true,
    headers: { authorization: `Bearer ${registrationToken}` },
    json: { email, first_name: "Digital", last_name: label.toUpperCase() },
    expected: [200, 201],
  })
  const login = await api("/auth/customer/emailpass", {
    method: "POST",
    json: { email, password },
    expected: [200, 201],
  })
  const token = record(login.data).token
  assert(typeof token === "string" && token.length > 32, "customer login must return a token")
  return { email, token }
}

async function createCommerceProduct(context) {
  const handle = `digital-e2e-${RUN_ID}`
  const response = await api("/admin/products", {
    method: "POST",
    admin: true,
    json: {
      title: `Digital Downloads E2E ${RUN_ID}`,
      handle,
      description: "Disposable packed-plugin E2E product",
      status: "published",
      shipping_profile_id: context.shippingProfileId,
      sales_channels: [{ id: context.salesChannelId }],
      options: [{ title: "Format", values: ["Digital"] }],
      variants: [
        {
          title: "Digital",
          sku: `DDE2E-${RUN_ID}`.toUpperCase().slice(0, 64),
          manage_inventory: false,
          allow_backorder: true,
          options: { Format: "Digital" },
          prices: [{ currency_code: context.currencyCode, amount: 1299 }],
        },
      ],
      metadata: { fixture: "medusa-digital-downloads-e2e", run_id: RUN_ID },
    },
    expected: [200, 201],
  })
  const product = record(record(response.data).product)
  const variant = record(array(product.variants)[0])
  assert(typeof product.id === "string", "product ID must be returned")
  assert(typeof variant.id === "string", "variant ID must be returned")
  return { product, variant, handle }
}

async function uploadAsset(releaseId, input, negativeTokenCheck = false) {
  const checksum = createHash("sha256").update(input.bytes).digest("hex")
  const initiated = await api("/admin/digital-downloads/uploads", {
    method: "POST",
    admin: true,
    json: {
      release_id: releaseId,
      filename: input.filename,
      mime_type: input.mimeType,
      size: input.bytes.length,
      checksum_sha256: checksum,
      storage_provider: STORAGE_PROVIDER,
      purpose: input.purpose,
      metadata: { run_id: RUN_ID },
    },
    expected: 201,
  })
  const descriptor = record(record(initiated.data).upload)
  assert(typeof descriptor.id === "string", "upload intent ID must be returned")
  assert(descriptor.method === "PUT", "upload descriptor must use PUT")
  const descriptorHeaders = record(descriptor.headers)

  if (STORAGE_PROVIDER === "local") {
    assert(String(descriptor.url).startsWith("/admin/digital-downloads/uploads/"), "local upload must use an Admin route")
    const uploadToken = descriptorHeaders["x-digital-upload-token"]
    assert(typeof uploadToken === "string", "local upload descriptor must contain a capability header")
    if (negativeTokenCheck) {
      const invalidUploadToken = `${uploadToken.slice(0, -1)}${uploadToken.endsWith("x") ? "y" : "x"}`
      await api(String(descriptor.url), {
        method: "PUT",
        admin: true,
        headers: {
          "content-type": input.mimeType,
          "content-length": String(input.bytes.length),
          "x-digital-upload-token": invalidUploadToken,
        },
        body: input.bytes,
        expected: [401, 403],
      })
    }
    await api(String(descriptor.url), {
      method: "PUT",
      admin: true,
      headers: {
        ...descriptorHeaders,
        "content-type": input.mimeType,
        "content-length": String(input.bytes.length),
      },
      body: input.bytes,
      expected: 202,
    })
  } else {
    assert(typeof descriptor.url === "string", "S3 upload must return a URL")
    assert(descriptorHeaders["if-none-match"] === "*", "S3 descriptor must prevent overwrite")
    await externalPut(String(descriptor.url), descriptorHeaders, input.bytes, [200, 201])
    await externalPut(String(descriptor.url), descriptorHeaders, input.bytes, [409, 412])
    if (negativeTokenCheck) {
      const anonymous = new URL(String(descriptor.url))
      anonymous.search = ""
      const direct = await fetch(anonymous, { redirect: "manual" })
      assert([401, 403].includes(direct.status), "private S3 object must reject anonymous GET")
      await direct.arrayBuffer()
    }
  }

  const completionPayload = {
    release_id: releaseId,
    checksum_sha256: checksum,
    size: input.bytes.length,
  }
  const completed = await api(`/admin/digital-downloads/uploads/${descriptor.id}/complete`, {
    method: "POST",
    admin: true,
    json: completionPayload,
    expected: 201,
  })
  const replay = await api(`/admin/digital-downloads/uploads/${descriptor.id}/complete`, {
    method: "POST",
    admin: true,
    json: completionPayload,
    expected: 201,
  })
  const asset = record(record(completed.data).asset)
  const replayAsset = record(record(replay.data).asset)
  assert(typeof asset.id === "string", "upload completion must create an asset")
  assert(replayAsset.id === asset.id, "upload completion replay must return the same asset")
  return { ...asset, expectedBytes: input.bytes, expectedChecksum: checksum }
}

async function checkout(context, input) {
  const auth = input.customerToken ? { customer: input.customerToken } : {}
  const cartResponse = await api("/store/carts", {
    method: "POST",
    store: true,
    ...auth,
    json: {
      region_id: context.regionId,
      sales_channel_id: context.salesChannelId,
      currency_code: context.currencyCode,
      email: input.email,
      shipping_address: {
        first_name: "Digital",
        last_name: "Buyer",
        address_1: "Fixture Lane 1",
        city: "Copenhagen",
        country_code: "dk",
        postal_code: "1000",
      },
      items: [{ variant_id: context.variantId, quantity: input.quantity }],
    },
    expected: [200, 201],
  })
  const cart = record(record(cartResponse.data).cart)
  assert(typeof cart.id === "string", "cart must be created")
  const shipping = await api(`/store/shipping-options?cart_id=${encodeURIComponent(cart.id)}`, {
    store: true,
    ...auth,
  })
  const option = record(array(record(shipping.data).shipping_options)[0])
  assert(typeof option.id === "string", "cart must have a shipping option")
  await api(`/store/carts/${cart.id}/shipping-methods`, {
    method: "POST",
    store: true,
    ...auth,
    json: { option_id: option.id },
    expected: [200, 201],
  })
  const collectionResponse = await api("/store/payment-collections", {
    method: "POST",
    store: true,
    ...auth,
    json: { cart_id: cart.id },
    expected: [200, 201],
  })
  const collection = record(record(collectionResponse.data).payment_collection)
  assert(typeof collection.id === "string", "payment collection must be created")
  await api(`/store/payment-collections/${collection.id}/payment-sessions`, {
    method: "POST",
    store: true,
    ...auth,
    json: { provider_id: "pp_system_default" },
    expected: [200, 201],
  })
  const completed = await api(`/store/carts/${cart.id}/complete`, {
    method: "POST",
    store: true,
    ...auth,
    json: {},
    expected: 200,
  })
  assert(record(completed.data).type === "order", "cart completion must return an order")
  const order = record(record(completed.data).order)
  assert(typeof order.id === "string", "completed order must have an ID")
  return order
}

async function listEntitlements(orderId) {
  const response = await api(
    `/admin/digital-downloads/entitlements?limit=100&order_id=${encodeURIComponent(orderId)}`,
    { admin: true },
  )
  return array(record(response.data).entitlements)
}

async function waitForDownloadCount(orderId, entitlementId, minimum) {
  return poll(
    `download accounting ${minimum} for ${entitlementId}`,
    async () =>
      record(
        (await listEntitlements(orderId)).find(
          (entitlement) => entitlement.id === entitlementId,
        ),
      ),
    (entitlement) => Number(entitlement.download_count ?? 0) >= minimum,
  )
}

async function ensureOrderPaymentCaptured(orderId) {
  const readPayment = async () => {
    const response = await api(`/admin/orders/${encodeURIComponent(orderId)}`, {
      admin: true,
    })
    const order = record(record(response.data).order)
    const payment = record(array(record(array(order.payment_collections)[0]).payments)[0])
    assert(typeof payment.id === "string", "completed paid order must have a payment")
    return payment
  }
  let payment = await readPayment()
  if (!payment.captured_at && Number(payment.captured_amount ?? 0) === 0) {
    await api(`/admin/payments/${encodeURIComponent(payment.id)}/capture`, {
      method: "POST",
      admin: true,
      json: {},
    })
    payment = await poll(
      `captured payment for ${orderId}`,
      readPayment,
      (candidate) =>
        Boolean(candidate.captured_at) ||
        Number(candidate.captured_amount ?? 0) > 0,
    )
  }
  return payment
}

async function awaitAutomaticEntitlements(orderId, quantity) {
  await ensureOrderPaymentCaptured(orderId)
  return poll(
    `${quantity} automatically issued entitlements for ${orderId}`,
    () => listEntitlements(orderId),
    (rows) => rows.length === quantity && rows.every((row) => row.status === "active"),
  )
}

async function assertIssueReplay(orderId, expectedEntitlements) {
  const issuePath = `/admin/digital-downloads/orders/${encodeURIComponent(orderId)}/issue`
  const concurrent = await Promise.all([
    api(issuePath, { method: "POST", admin: true, json: {}, expected: [202, 409] }),
    api(issuePath, { method: "POST", admin: true, json: {}, expected: [202, 409] }),
  ])
  assert(concurrent.some((entry) => entry.status === 202), "at least one concurrent issue request must succeed")
  const replay = await poll(
    `idempotent issue replay for ${orderId}`,
    () => listEntitlements(orderId),
    (rows) => rows.length === expectedEntitlements.length,
  )
  assert(
    replay.map((row) => row.id).sort().join(",") ===
      expectedEntitlements.map((row) => row.id).sort().join(","),
    "manual recovery replay must not create or replace entitlements",
  )
  return replay
}

async function library(token, orderId) {
  const response = await api(
    `/store/digital-downloads/library?limit=100&order_id=${encodeURIComponent(orderId)}`,
    { store: true, customer: token },
  )
  assertPrivate(response.headers)
  return array(record(response.data).entitlements)
}

async function customerGrant(token, entitlementId, assetId, action, idempotencyKey) {
  const response = await api(
    `/store/digital-downloads/entitlements/${encodeURIComponent(entitlementId)}/grants`,
    {
      method: "POST",
      store: true,
      customer: token,
      headers: { "idempotency-key": idempotencyKey },
      json: { asset_id: assetId, action },
      expected: 201,
    },
  )
  assertPrivate(response.headers)
  const grant = record(record(response.data).grant)
  assert(typeof grant.token === "string", "grant endpoint must return a bearer capability")
  assert(!String(grant.url).includes(grant.token), "grant token must not appear in its URL")
  return grant
}

async function content(grant, assetId, range, expected = 200) {
  return api(`/store/digital-downloads/content/${encodeURIComponent(assetId)}`, {
    method: "GET",
    store: true,
    headers: {
      authorization: `Bearer ${grant.token}`,
      ...(range ? { range } : {}),
    },
    expected,
    responseType: expectedStatuses(expected).some((status) => status >= 400) ? "json" : "bytes",
  })
}

async function guestToken(entitlementId) {
  await mkdir(path.dirname(RESULT_PATH), { recursive: true, mode: 0o700 })
  const output = path.join(path.dirname(RESULT_PATH), `guest-${entitlementId}.json`)
  await unlink(output).catch(() => undefined)
  const bridge = spawnSync("pnpm", ["medusa", "exec", BRIDGE_SCRIPT], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      E2E_BRIDGE_ACTION: "guest-token",
      E2E_ENTITLEMENT_ID: entitlementId,
      E2E_BRIDGE_OUTPUT: output,
    },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
  if (bridge.status !== 0) {
    throw new Error(`Fixture bridge failed: ${redactedText(`${bridge.stdout}\n${bridge.stderr}`)}`)
  }
  const payload = JSON.parse(await readFile(output, "utf8"))
  await unlink(output)
  assert(typeof payload.token === "string" && payload.token.length >= 32, "fixture bridge must return a guest capability")
  return payload.token
}

async function writeEvidence() {
  await mkdir(path.dirname(RESULT_PATH), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(RESULT_PATH), 0o700)
  const temporary = `${RESULT_PATH}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, RESULT_PATH)
}

async function main() {
  await step("health, metadata, and authentication boundaries", async () => {
    const health = await api("/health")
    assert(
      health.status === 200 && record(health.data).message === "OK",
      "Medusa health must return its native OK response",
    )
    const metadata = await api("/store/digital-downloads", { store: true })
    const plugin = record(record(metadata.data).plugin)
    assert(plugin.version === "0.3.0", "plugin metadata version must be 0.3.0")
    assert(
      record(plugin.attribution).text === "Brought to you by MakePay.io — crypto payment gateway.",
      "plugin attribution must match the MakePay text exactly",
    )
    await api("/admin/digital-downloads/settings", { expected: 401 })
    await api("/store/digital-downloads/library", { store: true, expected: 401 })
    await authenticateAdmin()
  })

  const context = await step("fixture commerce context and plugin readiness", async () => {
    const [salesChannels, shippingProfiles, regions] = await Promise.all([
      api("/admin/sales-channels?limit=100", { admin: true }),
      api("/admin/shipping-profiles?limit=100", { admin: true }),
      api("/store/regions?limit=100", { store: true }),
    ])
    const salesChannel = record(array(record(salesChannels.data).sales_channels)[0])
    const shippingProfile = record(array(record(shippingProfiles.data).shipping_profiles)[0])
    const region = record(array(record(regions.data).regions)[0])
    assert(typeof salesChannel.id === "string", "a sales channel must exist")
    assert(typeof shippingProfile.id === "string", "a shipping profile must exist")
    assert(typeof region.id === "string", "a region must exist")
    const settingsResponse = await api("/admin/digital-downloads/settings", { admin: true })
    const settings = record(record(settingsResponse.data).settings)
    assert(record(settings.readiness).ready === true, "plugin readiness must be true")
    assert(settings.storage?.provider === STORAGE_PROVIDER, "reported storage provider must match the run")
    await api("/admin/digital-downloads/settings", {
      method: "PATCH",
      admin: true,
      json: {
        enabled: true,
        allow_guest_access: true,
        default_download_limit: 2,
        default_grant_ttl_seconds: 300,
        max_grant_ttl_seconds: 900,
      },
    })
    await api("/admin/digital-downloads/settings/test-storage", {
      method: "POST",
      admin: true,
      json: { operation: "write_read_delete" },
      expected: [200, 201],
    })
    return {
      salesChannelId: salesChannel.id,
      shippingProfileId: shippingProfile.id,
      regionId: region.id,
      currencyCode: String(region.currency_code ?? "eur"),
    }
  })

  const catalog = await step("native product, digital config, license policy, and release", async () => {
    const commerce = await createCommerceProduct(context)
    const productConfigResponse = await api("/admin/digital-downloads/product-configs", {
      method: "POST",
      admin: true,
      json: {
        product_id: commerce.product.id,
        variant_ids: [commerce.variant.id],
        title: commerce.product.title,
        description: "Mixed ebook, audio, preview, and generated license",
        status: "draft",
        delivery_type: "mixed",
        fulfillment_strategy: "payment_captured",
        download_limit: 2,
        preview_enabled: true,
        update_policy: "purchased_release",
        metadata: { kind: "bundle", run_id: RUN_ID },
      },
      expected: 201,
    })
    const productConfig = record(record(productConfigResponse.data).product_config)
    assert(typeof productConfig.id === "string", "digital product config must be created")
    const policyResponse = await api("/admin/digital-downloads/license-policies", {
      method: "POST",
      admin: true,
      json: {
        digital_product_id: productConfig.id,
        strategy: "generated",
        license_pattern: "DD-{ALNUM:5}-{ALNUM:5}-{ALNUM:6}",
        activation_limit: 1,
        validity_days: 365,
        allow_offline_activation: false,
        require_device_id: true,
        is_enabled: true,
        metadata: { run_id: RUN_ID },
      },
      expected: 201,
    })
    const policy = record(record(policyResponse.data).license_policy)
    assert(typeof policy.id === "string", "license policy must be created")
    await api(`/admin/digital-downloads/product-configs/${productConfig.id}`, {
      method: "PATCH",
      admin: true,
      json: { license_policy_id: policy.id },
    })
    const releaseResponse = await api("/admin/digital-downloads/releases", {
      method: "POST",
      admin: true,
      json: {
        product_config_id: productConfig.id,
        version: "1.0.0",
        title: "Packed fixture release 1.0.0",
        notes: "Created by the isolated packed-plugin lifecycle",
        status: "draft",
        asset_ids: [],
        metadata: { run_id: RUN_ID },
      },
      expected: 201,
    })
    const release = record(record(releaseResponse.data).release)
    assert(typeof release.id === "string", "release must be created")
    return { ...commerce, productConfig, policy, release }
  })

  const assets = await step("streamed uploads, immutable completion, and S3 privacy", async () => {
    const ebookBytes = Buffer.from(`MakePay digital downloads E2E ebook\n${RUN_ID}\n0123456789abcdefghijklmnopqrstuvwxyz\n`)
    const audioBytes = Buffer.concat([
      Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0015"),
      Buffer.from(`fixture-audio-${RUN_ID}-0123456789abcdefghijklmnopqrstuvwxyz`),
    ])
    const previewBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`fixture-preview-${RUN_ID}`),
    ])
    const ebook = await uploadAsset(
      catalog.release.id,
      { filename: "makepay-e2e-ebook.pdf", mimeType: "application/pdf", bytes: ebookBytes, purpose: "download" },
      true,
    )
    const audio = await uploadAsset(catalog.release.id, {
      filename: "makepay-e2e-track.mp3",
      mimeType: "audio/mpeg",
      bytes: audioBytes,
      purpose: "stream",
    })
    const preview = await uploadAsset(catalog.release.id, {
      filename: "makepay-e2e-preview.png",
      mimeType: "image/png",
      bytes: previewBytes,
      purpose: "preview",
    })
    return { ebook, audio, preview }
  })

  await step("release readiness, publication, and public projection", async () => {
    await api(`/store/digital-downloads/previews/${assets.preview.id}`, {
      store: true,
      expected: 404,
    })
    await api(`/admin/digital-downloads/releases/${catalog.release.id}`, {
      method: "PATCH",
      admin: true,
      json: { status: "ready", asset_ids: [assets.ebook.id, assets.audio.id, assets.preview.id] },
    })
    const published = await api(`/admin/digital-downloads/releases/${catalog.release.id}/publish`, {
      method: "POST",
      admin: true,
      json: { make_active: true, notify_existing_customers: false },
    })
    assert(record(record(published.data).release).status === "published", "release must publish")
    await api(`/admin/digital-downloads/releases/${catalog.release.id}`, {
      method: "PATCH",
      admin: true,
      json: { title: "Forbidden mutation" },
      expected: 409,
    })
    const publicProduct = await api(`/store/digital-downloads/products/${catalog.variant.id}`, {
      store: true,
    })
    const projection = record(record(publicProduct.data).product)
    const deliveryTypes = array(projection.delivery_types)
    for (const type of ["download", "stream", "license"]) {
      assert(deliveryTypes.includes(type), `public product must include ${type}`)
    }
    assert(array(projection.previews).length === 1, "public product must expose one preview")
    const preview = await api(`/store/digital-downloads/previews/${assets.preview.id}`, {
      store: true,
      headers: { range: "bytes=0-3" },
      expected: 206,
      responseType: "bytes",
    })
    assert(preview.headers.get("cache-control")?.includes("public"), "public preview must have bounded public caching")
    assert(preview.headers.get("x-content-type-options") === "nosniff", "preview must set nosniff")
    assert(Buffer.compare(preview.data, assets.preview.expectedBytes.subarray(0, 4)) === 0, "preview range bytes must match")
  })

  const customers = await step("customer registration and isolation", async () => {
    const customerA = await registerCustomer("customer-a")
    const customerB = await registerCustomer("customer-b")
    customerAToken = customerA.token
    customerBToken = customerB.token
    return { customerA, customerB }
  })

  const customerOrder = await step("native checkout and idempotent entitlement issuance", async () => {
    const order = await checkout(
      { ...context, variantId: catalog.variant.id },
      { email: customers.customerA.email, customerToken: customerAToken, quantity: 2 },
    )
    const entitlements = await awaitAutomaticEntitlements(order.id, 2)
    await assertIssueReplay(order.id, entitlements)
    const customerLibrary = await poll(
      "customer library hydration",
      () => library(customerAToken, order.id),
      (rows) => rows.length === 2 && rows.every((row) => array(row.assets).length >= 2),
    )
    assert(customerLibrary.every((row) => record(row.license).id), "each purchased unit must have a license")
    const foreign = await api(`/store/digital-downloads/entitlements/${entitlements[0].id}`, {
      store: true,
      customer: customerBToken,
      expected: 404,
    })
    assertPrivate(foreign.headers)
    assert((await library(customerBToken, order.id)).length === 0, "customer B must not enumerate customer A's order")
    return { order, entitlements, library: customerLibrary }
  })

  let lastUsableGrant
  let revealedLicenseKey
  await step("grant replay, ranges, stream delivery, and transfer races", async () => {
    const entitlementOne = customerOrder.library[0]
    const entitlementTwo = customerOrder.library[1]
    const ebook = array(entitlementOne.assets).find((asset) => asset.id === assets.ebook.id)
    const audio = array(entitlementTwo.assets).find((asset) => asset.id === assets.audio.id)
    assert(ebook && audio, "library must include ebook and audio assets")

    const rangeKey = `${RUN_ID}:customer-range`
    const rangeGrant = await customerGrant(customerAToken, entitlementOne.id, assets.ebook.id, "download", rangeKey)
    const rangeReplay = await customerGrant(customerAToken, entitlementOne.id, assets.ebook.id, "download", rangeKey)
    assert(rangeReplay.token === rangeGrant.token, "idempotent grant replay must return the same token")
    await api(`/store/digital-downloads/content/${assets.ebook.id}?token=forbidden`, {
      store: true,
      headers: { authorization: `Bearer ${rangeGrant.token}` },
      expected: 400,
    })
    await content(rangeGrant, assets.ebook.id, "bytes=0-1,4-5", 416)
    const firstRange = await content(rangeGrant, assets.ebook.id, "bytes=0-9", 206)
    await waitForDownloadCount(customerOrder.order.id, entitlementOne.id, 1)
    const secondRange = await content(rangeGrant, assets.ebook.id, "bytes=10-19", 206)
    assertPrivate(firstRange.headers)
    assert(firstRange.headers.get("content-range") === `bytes 0-9/${assets.ebook.expectedBytes.length}`, "first range header must match")
    assert(Buffer.compare(firstRange.data, assets.ebook.expectedBytes.subarray(0, 10)) === 0, "first range bytes must match")
    assert(Buffer.compare(secondRange.data, assets.ebook.expectedBytes.subarray(10, 20)) === 0, "range continuation bytes must match")

    const streamGrant = await customerGrant(
      customerAToken,
      entitlementTwo.id,
      assets.audio.id,
      "stream",
      `${RUN_ID}:customer-stream`,
    )
    const wrongAsset = await content(streamGrant, assets.ebook.id, undefined, [403, 404])
    assertPrivate(wrongAsset.headers)
    const streamed = await content(streamGrant, assets.audio.id, undefined, 200)
    await waitForDownloadCount(customerOrder.order.id, entitlementTwo.id, 1)
    assert(Buffer.compare(streamed.data, assets.audio.expectedBytes) === 0, "stream bytes must match")
    assert(streamed.headers.get("content-disposition")?.startsWith("inline"), "stream must be inline")

    const raceGrant = await customerGrant(
      customerAToken,
      entitlementTwo.id,
      assets.ebook.id,
      "download",
      `${RUN_ID}:customer-race`,
    )
    const raceResponses = await Promise.all([
      content(raceGrant, assets.ebook.id, undefined, [200, 403, 409]),
      content(raceGrant, assets.ebook.id, undefined, [200, 403, 409]),
    ])
    const statuses = raceResponses.map((entry) => entry.status).sort((a, b) => a - b)
    assert(statuses.filter((status) => status === 200).length === 1, "one concurrent transfer must succeed")
    assert(statuses.some((status) => status === 403 || status === 409), "one concurrent transfer must be denied")
    await waitForDownloadCount(customerOrder.order.id, entitlementTwo.id, 2)

    const exhaustedGrant = await customerGrant(
      customerAToken,
      entitlementTwo.id,
      assets.ebook.id,
      "download",
      `${RUN_ID}:customer-exhausted`,
    )
    await content(exhaustedGrant, assets.ebook.id, undefined, [403, 409])
    lastUsableGrant = await customerGrant(
      customerAToken,
      entitlementOne.id,
      assets.ebook.id,
      "download",
      `${RUN_ID}:revoke-probe`,
    )
  })

  await step("license reveal, activation cap, heartbeat, validate, and deactivate", async () => {
    const entitlement = customerOrder.library[0]
    const assignment = record(entitlement.license)
    const reveal = await api(`/store/digital-downloads/licenses/${assignment.id}/reveal`, {
      method: "POST",
      store: true,
      customer: customerAToken,
      json: { reason: "packed fixture activation" },
    })
    assertPrivate(reveal.headers)
    revealedLicenseKey = record(reveal.data).license_key
    assert(typeof revealedLicenseKey === "string" && revealedLicenseKey.length >= 8, "license reveal must return a key")
    const activate = await api("/store/digital-downloads/licenses/activate", {
      method: "POST",
      store: true,
      headers: { "idempotency-key": `${RUN_ID}:activate-one` },
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-one", label: "Fixture device" },
    })
    assertPrivate(activate.headers)
    assert(!JSON.stringify(activate.data).includes("fingerprint"), "activation response must not leak fingerprints")
    await api("/store/digital-downloads/licenses/heartbeat", {
      method: "POST",
      store: true,
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-one", metadata: { build: "1.0.0" } },
    })
    const valid = await api("/store/digital-downloads/licenses/validate", {
      method: "POST",
      store: true,
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-one" },
    })
    assert(record(valid.data).valid === true, "activated license must validate")
    await api("/store/digital-downloads/licenses/activate", {
      method: "POST",
      store: true,
      headers: { "idempotency-key": `${RUN_ID}:activate-two` },
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-two" },
      expected: [403, 409, 422],
    })
    await api("/store/digital-downloads/licenses/deactivate", {
      method: "POST",
      store: true,
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-one", reason: "fixture rotation" },
    })
    await api("/store/digital-downloads/licenses/activate", {
      method: "POST",
      store: true,
      headers: { "idempotency-key": `${RUN_ID}:activate-two-after-release` },
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-two" },
    })
  })

  await step("manual revoke and reissue invalidate then restore access", async () => {
    const entitlementId = customerOrder.library[0].id
    const revoked = await api(`/admin/digital-downloads/entitlements/${entitlementId}/revoke`, {
      method: "POST",
      admin: true,
      json: { reason: "Packed fixture manual revoke", notify: false },
    })
    assert(record(record(revoked.data).entitlement).status === "revoked", "entitlement must revoke")
    await content(lastUsableGrant, assets.ebook.id, undefined, [403, 409])
    const invalidLicense = await api("/store/digital-downloads/licenses/validate", {
      method: "POST",
      store: true,
      json: { license_key: revealedLicenseKey, instance_id: "fixture-device-two" },
    })
    assert(record(invalidLicense.data).valid === false, "revoked license must be invalid")
    const reissued = await api(`/admin/digital-downloads/entitlements/${entitlementId}/reissue`, {
      method: "POST",
      admin: true,
      json: {
        reason: "Packed fixture recovery",
        notify: false,
        reset_downloads: true,
        rotate_guest_token: true,
      },
    })
    assert(record(record(reissued.data).entitlement).status === "active", "entitlement must reissue")
    const restored = await customerGrant(
      customerAToken,
      entitlementId,
      assets.ebook.id,
      "download",
      `${RUN_ID}:restored-download`,
    )
    const downloaded = await content(restored, assets.ebook.id, undefined, 200)
    assert(Buffer.compare(downloaded.data, assets.ebook.expectedBytes) === 0, "reissued download must match")
    await waitForDownloadCount(customerOrder.order.id, entitlementId, 1)
    lastUsableGrant = await customerGrant(
      customerAToken,
      entitlementId,
      assets.ebook.id,
      "download",
      `${RUN_ID}:refund-probe`,
    )
  })

  await step("full native payment refund revokes every purchased unit", async () => {
    let orderResponse = await api(`/admin/orders/${customerOrder.order.id}`, { admin: true })
    let order = record(record(orderResponse.data).order)
    let payment = record(array(record(array(order.payment_collections)[0]).payments)[0])
    assert(typeof payment.id === "string", "completed order must have a payment")
    if (!payment.captured_at && Number(payment.captured_amount ?? 0) === 0) {
      await api(`/admin/payments/${payment.id}/capture`, {
        method: "POST",
        admin: true,
        json: {},
      })
      orderResponse = await api(`/admin/orders/${customerOrder.order.id}`, { admin: true })
      order = record(record(orderResponse.data).order)
      payment = record(array(record(array(order.payment_collections)[0]).payments)[0])
    }
    await api(`/admin/payments/${payment.id}/refund`, {
      method: "POST",
      admin: true,
      json: { note: "Packed fixture full refund" },
    })
    const refunded = await poll(
      "refund-driven entitlement revocation",
      () => listEntitlements(customerOrder.order.id),
      (rows) => rows.length === 2 && rows.every((row) => row.status === "refunded"),
    )
    assert(refunded.length === 2, "full refund must cover both quantity units")
    await content(lastUsableGrant, assets.ebook.id, undefined, [403, 409])
    await api(`/admin/digital-downloads/entitlements/${customerOrder.library[0].id}/reissue`, {
      method: "POST",
      admin: true,
      json: { reason: "Forbidden refund reissue", notify: false, reset_downloads: true },
      expected: 409,
    })
  })

  const guestOrder = await step("guest checkout, capability access, grant, and revocation", async () => {
    const guestEmail = `${RUN_ID}-guest@digital-downloads.local`
    const order = await checkout(
      { ...context, variantId: catalog.variant.id },
      { email: guestEmail, quantity: 1 },
    )
    const automaticEntitlements = await awaitAutomaticEntitlements(order.id, 1)
    await assertIssueReplay(order.id, automaticEntitlements)
    const [adminEntitlement] = automaticEntitlements
    assert(!adminEntitlement.customer_id, "guest entitlement must not have a customer owner")
    const guestAccessToken = await guestToken(adminEntitlement.id)
    const access = await api("/store/digital-downloads/guest/access", {
      method: "POST",
      store: true,
      json: { token: guestAccessToken, email: guestEmail },
    })
    assertPrivate(access.headers)
    const guestEntitlement = record(record(access.data).entitlement)
    assert(guestEntitlement.id === adminEntitlement.id, "guest capability must resolve its entitlement")
    const grantResponse = await api("/store/digital-downloads/guest/grants", {
      method: "POST",
      store: true,
      headers: { "idempotency-key": `${RUN_ID}:guest-grant` },
      json: {
        token: guestAccessToken,
        email: guestEmail,
        entitlement_id: adminEntitlement.id,
        asset_id: assets.ebook.id,
        action: "download",
      },
      expected: 201,
    })
    const grant = record(record(grantResponse.data).grant)
    const downloaded = await content(grant, assets.ebook.id, "bytes=0-7", 206)
    assert(Buffer.compare(downloaded.data, assets.ebook.expectedBytes.subarray(0, 8)) === 0, "guest range must match")
    await waitForDownloadCount(order.id, adminEntitlement.id, 1)
    await api(`/admin/digital-downloads/entitlements/${adminEntitlement.id}/revoke`, {
      method: "POST",
      admin: true,
      json: { reason: "Packed fixture guest revoke", notify: false },
    })
    await api("/store/digital-downloads/guest/access", {
      method: "POST",
      store: true,
      json: { token: guestAccessToken, email: guestEmail },
      expected: [401, 403, 404],
    })
    await content(grant, assets.ebook.id, "bytes=8-15", [403, 409])
    return { order, entitlement: adminEntitlement }
  })

  const canceledOrder = await step("native order cancellation applies cancellation policy once", async () => {
    const order = await checkout(
      { ...context, variantId: catalog.variant.id },
      { email: `${RUN_ID}-cancel@digital-downloads.local`, quantity: 1 },
    )
    const orderResponse = await api(`/admin/orders/${encodeURIComponent(order.id)}`, {
      admin: true,
    })
    const retrievedOrder = record(record(orderResponse.data).order)
    const payment = record(
      array(record(array(retrievedOrder.payment_collections)[0]).payments)[0],
    )
    assert(typeof payment.id === "string", "cancellation order must have a payment")
    assert(
      !payment.captured_at && Number(payment.captured_amount ?? 0) === 0,
      "cancellation policy probe requires an uncaptured payment",
    )
    const issuePath = `/admin/digital-downloads/orders/${encodeURIComponent(order.id)}/issue`
    await api(issuePath, {
      method: "POST",
      admin: true,
      json: {},
      expected: 202,
    })
    const manuallyIssued = await poll(
      `manually issued cancellation entitlement for ${order.id}`,
      () => listEntitlements(order.id),
      (rows) => rows.length === 1 && rows[0].status === "active",
    )
    await assertIssueReplay(order.id, manuallyIssued)
    await api(`/admin/orders/${order.id}/cancel`, {
      method: "POST",
      admin: true,
      json: {},
    })
    const [entitlement] = await poll(
      "cancellation-driven entitlement revocation",
      () => listEntitlements(order.id),
      (rows) => rows.length === 1 && rows[0].status === "revoked",
    )
    return { order, entitlement }
  })

  await step("reports and audit projections remain secret-free", async () => {
    const [downloads, audit, report] = await Promise.all([
      api("/admin/digital-downloads/downloads?limit=100", { admin: true }),
      api("/admin/digital-downloads/audit-events?limit=100", { admin: true }),
      api("/admin/digital-downloads/reports/summary", { admin: true }),
    ])
    const serialized = JSON.stringify([downloads.data, audit.data, report.data])
    for (const secret of [adminToken, customerAToken, customerBToken, revealedLicenseKey, lastUsableGrant.token]) {
      assert(!serialized.includes(secret), "operational projections must not contain raw capabilities")
    }
    evidence.assertions.download_event_count = array(record(downloads.data).downloads).length
    evidence.assertions.audit_event_count = array(record(audit.data).audit_events).length
    evidence.assertions.report_available = Boolean(record(report.data).report)
  })

  evidence.resources = {
    medusa_product_id: catalog.product.id,
    variant_id: catalog.variant.id,
    product_handle: catalog.handle,
    digital_product_id: catalog.productConfig.id,
    release_id: catalog.release.id,
    asset_ids: [assets.ebook.id, assets.audio.id, assets.preview.id],
    license_policy_id: catalog.policy.id,
    customer_order_id: customerOrder.order.id,
    guest_order_id: guestOrder.order.id,
    canceled_order_id: canceledOrder.order.id,
  }
  evidence.assertions = {
    ...evidence.assertions,
    customer_quantity_entitlements: 2,
    guest_entitlements: 1,
    refund_status: "refunded",
    cancellation_status: "revoked",
    range_delivery: true,
    stream_delivery: true,
    license_activation_cap: 1,
    cross_customer_hidden: true,
    upload_completion_idempotent: true,
  }
  evidence.status = "passed"
  evidence.completed_at = new Date().toISOString()
  await writeEvidence()
  process.stdout.write(`[packed-e2e] Lifecycle passed; evidence: ${RESULT_PATH}\n`)
}

main().catch(async (error) => {
  evidence.status = "failed"
  evidence.completed_at = new Date().toISOString()
  evidence.failure = redactedText(error?.stack ?? error)
  await writeEvidence().catch(() => undefined)
  process.stderr.write(`[packed-e2e] Lifecycle failed: ${redactedText(error?.message ?? error)}\n`)
  process.exitCode = 1
})
