import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import path from "node:path"

import {
  FeatureFlag,
  Modules,
} from "@medusajs/framework/utils"

const fixtureRootInput = process.env.E2E_FIXTURE_ROOT?.trim()
if (!fixtureRootInput || !path.isAbsolute(fixtureRootInput)) {
  throw new Error("E2E_FIXTURE_ROOT must be an absolute disposable fixture path")
}
const FIXTURE_ROOT = realpathSync(path.resolve(fixtureRootInput))
const RUNTIME_ROOT = path.join(FIXTURE_ROOT, "runtime")
const PLUGIN_NAME = "@makecrypto/medusa-plugin-digital-downloads"

if (
  new Set([
    path.parse(FIXTURE_ROOT).root,
    path.resolve(homedir()),
    path.resolve(__dirname, "../.."),
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

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing fixture environment variable ${name}`)
  return value
}

function safeIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

function strictDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function safeNotificationProjection(delivery: Record<string, any>) {
  return {
    id: delivery.id,
    entitlement_id: delivery.entitlement_id,
    state: delivery.state,
    attempt_count: Number(delivery.attempt_count ?? 0),
    template: delivery.template,
    sent_at: delivery.sent_at ?? null,
    provider_message_id: delivery.provider_message_id ?? null,
    error_code: delivery.error_code ?? null,
    next_retry_at: delivery.next_retry_at ?? null,
  }
}

async function bridgeOutputPath(): Promise<string> {
  await mkdir(RUNTIME_ROOT, { recursive: true, mode: 0o700 })
  await chmod(RUNTIME_ROOT, 0o700)
  const canonicalRuntime = await realpath(RUNTIME_ROOT)
  const requestedOutput = path.resolve(required("E2E_BRIDGE_OUTPUT"))
  if (!strictDescendant(canonicalRuntime, requestedOutput)) {
    throw new Error(
      "Bridge output must be a file below the private fixture runtime directory"
    )
  }
  if (await lstat(requestedOutput).catch(() => undefined)) {
    throw new Error("Bridge output already exists")
  }
  return requestedOutput
}

async function writeBridgeOutput(payload: Record<string, unknown>): Promise<void> {
  const requestedOutput = await bridgeOutputPath()
  const temporary = `${requestedOutput}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(payload)}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, requestedOutput)
  const stored = await lstat(requestedOutput)
  if (stored.isSymbolicLink() || !stored.isFile() || (stored.mode & 0o077) !== 0) {
    throw new Error("Bridge output permissions are unsafe")
  }
}

async function deliveryForEntitlement(
  service: any,
  entitlementId: string
): Promise<Record<string, any>> {
  const deliveries = await service.listNotificationDeliveries(
    {
      entitlement_id: entitlementId,
      template: "digital-downloads-delivery",
    },
    { take: 10 }
  )
  if (deliveries.length !== 1) {
    throw new Error("Expected exactly one delivery notification for entitlement")
  }
  return deliveries[0]
}

async function retryNotification(
  container: any,
  service: any,
  entitlementId: string
): Promise<Record<string, any>> {
  const delivery = await deliveryForEntitlement(service, entitlementId)
  if (delivery.state !== "failed") {
    throw new Error("Only a failed fixture notification may be retried")
  }
  await service.updateNotificationDeliveries({
    id: delivery.id,
    next_retry_at: new Date(0),
    lease_owner: null,
    lease_expires_at: null,
  })

  const requireFromBackend = createRequire(
    path.join(process.cwd(), "package.json")
  )
  const packageJsonPath = await realpath(
    requireFromBackend.resolve(`${PLUGIN_NAME}/package.json`)
  )
  const packageRoot = path.dirname(packageJsonPath)
  const subscriberPath = await realpath(
    path.join(
      packageRoot,
      ".medusa/server/src/subscribers/digital-notification-requested.js"
    )
  )
  if (!strictDescendant(packageRoot, subscriberPath)) {
    throw new Error("Installed notification subscriber escaped its package root")
  }
  const subscriber = requireFromBackend(subscriberPath)
  const handler = subscriber.default ?? subscriber.deliverDigitalNotification
  if (typeof handler !== "function") {
    throw new Error("Installed notification subscriber is unavailable")
  }
  await handler({
    event: {
      name: "digital_downloads.notification.requested",
      data: { delivery_id: delivery.id },
    },
    container,
  })
  return deliveryForEntitlement(service, entitlementId)
}

async function ensureFixtureAdmin(container: any): Promise<void> {
  const email = required("E2E_ADMIN_EMAIL")
  const password = required("E2E_ADMIN_PASSWORD")
  const userService = container.resolve(Modules.USER)
  const authService = container.resolve(Modules.AUTH)
  const existing = await userService.listUsers({ email }, { take: 2 })

  if (existing.length > 1) {
    throw new Error("Fixture administrator email is not unique")
  }
  if (existing.length === 1) {
    const authenticated = await authService.authenticate("emailpass", {
      body: { email, password },
    })
    if (
      authenticated.success !== true ||
      authenticated.authIdentity?.app_metadata?.user_id !== existing[0].id
    ) {
      throw new Error("Existing fixture administrator credentials or identity are invalid")
    }
    process.stdout.write("Fixture administrator already exists and authenticated successfully.\n")
    return
  }

  const roles: string[] = []
  if (FeatureFlag.isFeatureEnabled("rbac")) {
    const rbacService = container.resolve(Modules.RBAC)
    const superAdminRoles = await rbacService.listRbacRoles({
      id: "role_super_admin",
    })
    if (superAdminRoles[0]?.id) roles.push(superAdminRoles[0].id)
  }
  const workflowService = container.resolve(Modules.WORKFLOW_ENGINE)
  const { result: users } = await workflowService.run("create-users-workflow", {
    input: { users: [{ email, roles }] },
  })
  const user = users[0]
  const registered = await authService.register("emailpass", {
    body: { email, password },
  })
  if (!registered.authIdentity?.id || registered.error) {
    throw new Error("Unable to register the fixture administrator identity")
  }
  await authService.updateAuthIdentities({
    id: registered.authIdentity.id,
    app_metadata: { user_id: user.id },
  })
  process.stdout.write("Fixture administrator created successfully.\n")
}

export default async function fixtureBridge({ container }: { container: any }) {
  if (process.env.DIGITAL_DOWNLOADS_E2E !== "1") {
    throw new Error("DIGITAL_DOWNLOADS_E2E=1 is required")
  }
  const action = required("E2E_BRIDGE_ACTION")
  if (action === "ensure-admin") {
    await ensureFixtureAdmin(container)
    return
  }

  const entitlementId = safeIdentifier(
    required("E2E_ENTITLEMENT_ID"),
    "entitlement ID",
  )
  const service = container.resolve("digitalDownloads") as any

  if (action === "notification-state") {
    const delivery = await deliveryForEntitlement(service, entitlementId)
    await writeBridgeOutput({ delivery: safeNotificationProjection(delivery) })
    return
  }

  if (action === "retry-notification") {
    const delivery = await retryNotification(container, service, entitlementId)
    await writeBridgeOutput({ delivery: safeNotificationProjection(delivery) })
    return
  }

  if (action !== "guest-token") {
    throw new Error("Unsupported fixture bridge action")
  }

  const result = await service.createGuestAccessSession({
    entitlement_id: entitlementId,
    idempotency_key: `${entitlementId}:guest:v1`,
    metadata: { purpose: "packed_fixture_e2e" },
  })
  await writeBridgeOutput({ token: result.token, session_id: result.session.id })
}
