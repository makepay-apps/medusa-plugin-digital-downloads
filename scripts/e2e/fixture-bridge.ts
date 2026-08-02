import { chmod, mkdir, realpath, rename, writeFile } from "node:fs/promises"
import { readFileSync, realpathSync } from "node:fs"
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
  if (action !== "guest-token") {
    throw new Error("Unsupported fixture bridge action")
  }

  await mkdir(RUNTIME_ROOT, { recursive: true, mode: 0o700 })
  await chmod(RUNTIME_ROOT, 0o700)
  const canonicalRuntime = await realpath(RUNTIME_ROOT)
  const requestedOutput = path.resolve(required("E2E_BRIDGE_OUTPUT"))
  const relativeOutput = path.relative(canonicalRuntime, requestedOutput)
  if (
    !relativeOutput ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new Error("Bridge output must be a file below the private fixture runtime directory")
  }

  const entitlementId = safeIdentifier(
    required("E2E_ENTITLEMENT_ID"),
    "entitlement ID",
  )
  const service = container.resolve("digitalDownloads") as any
  const result = await service.createGuestAccessSession({
    entitlement_id: entitlementId,
    idempotency_key: `${entitlementId}:guest:v1`,
    metadata: { purpose: "packed_fixture_e2e" },
  })

  const temporary = `${requestedOutput}.${process.pid}.tmp`
  await writeFile(
    temporary,
    `${JSON.stringify({ token: result.token, session_id: result.session.id })}\n`,
    { mode: 0o600, flag: "wx" },
  )
  await rename(temporary, requestedOutput)
}
