import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
)
const runtimeExports = [
  "./package.json",
  "./workflows",
  "./.medusa/server/src/modules/digital-downloads",
  "./modules/digital-downloads",
  "./providers/digital-fulfillment",
  "./storefront",
  "./admin",
]
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "medusa-digital-downloads-packed-types-"),
)

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n")
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`)
  }
  return result.stdout
}

async function linkInstalledPackage(name, consumerNodeModules) {
  const source = path.join(repositoryRoot, "node_modules", ...name.split("/"))
  const destination = path.join(consumerNodeModules, ...name.split("/"))
  await mkdir(path.dirname(destination), { recursive: true })
  await symlink(source, destination, "dir")
}

function exportTargets(exportDefinition) {
  if (typeof exportDefinition === "string") {
    return [exportDefinition]
  }
  if (!exportDefinition || typeof exportDefinition !== "object") {
    throw new Error("package export must be a string or condition map")
  }
  return Object.values(exportDefinition).flatMap(exportTargets)
}

function wildcardCaptures(pattern, subpath) {
  const expression = new RegExp(
    `^${pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", "(.*)")}$`,
  )
  return subpath.match(expression)?.slice(1)
}

async function assertExportTargetsExist(packageDirectory, exports) {
  for (const [subpath, definition] of Object.entries(exports ?? {})) {
    for (const target of exportTargets(definition)) {
      if (!target.startsWith("./")) {
        throw new Error(`export ${subpath} has an invalid target: ${target}`)
      }
      const targets = target.includes("*")
        ? runtimeExports
            .map((runtimeExport) => wildcardCaptures(subpath, runtimeExport))
            .filter(Boolean)
            .map((captures) =>
              captures.reduce(
                (resolvedTarget, capture) => resolvedTarget.replace("*", capture),
                target,
              ),
            )
        : [target]
      if (targets.length === 0) {
        throw new Error(`export ${subpath} has no supported runtime subpaths`)
      }
      for (const resolvedTarget of targets) {
        try {
          await readFile(path.join(packageDirectory, resolvedTarget), "utf8")
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new Error(
              `export ${subpath} targets a missing file: ${resolvedTarget}`,
            )
          }
          throw error
        }
      }
    }
  }
}

try {
  const packOutput = run(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    repositoryRoot,
  )
  const [packed] = JSON.parse(packOutput)
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error("npm pack did not return a package manifest")
  }

  const packedPaths = new Set(packed.files.map((entry) => entry.path))
  const requiredPaths = [
    "types/workflows.d.ts",
    "types/modules/digital-downloads.d.ts",
    "types/providers/digital-fulfillment.d.ts",
    ".medusa/server/src/storefront/index.d.ts",
    ".medusa/server/src/modules/digital-downloads/migrations/Migration20260731221936.js",
    ".medusa/server/src/modules/digital-downloads/migrations/Migration20260801114300.js",
  ]
  for (const requiredPath of requiredPaths) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`packed package is missing ${requiredPath}`)
    }
  }

  const forbiddenPath = [...packedPaths].find(
    (packedPath) =>
      packedPath.includes("scripts/e2e") ||
      /(^|\/)(?:tests?|__tests__|integration-tests|coverage)(\/|$)/.test(
        packedPath,
      ) ||
      packedPath.endsWith(".tsbuildinfo") ||
      packedPath.endsWith(".map"),
  )
  if (forbiddenPath) {
    throw new Error(`packed package contains test/build residue: ${forbiddenPath}`)
  }

  const archive = path.join(temporaryRoot, packed.filename)
  const extracted = path.join(temporaryRoot, "extracted")
  const consumer = path.join(temporaryRoot, "consumer")
  const consumerNodeModules = path.join(consumer, "node_modules")
  const packageTarget = path.join(
    consumerNodeModules,
    "@makecrypto",
    "medusa-plugin-digital-downloads",
  )
  await mkdir(extracted, { recursive: true })
  await mkdir(path.dirname(packageTarget), { recursive: true })
  run("tar", ["-xzf", archive, "-C", extracted], repositoryRoot)
  await rename(path.join(extracted, "package"), packageTarget)

  const packedPackageJson = JSON.parse(
    await readFile(path.join(packageTarget, "package.json"), "utf8"),
  )
  await assertExportTargetsExist(packageTarget, packedPackageJson.exports)

  const consumerRequire = createRequire(path.join(consumer, "package.json"))
  for (const subpath of runtimeExports) {
    const specifier = `${packedPackageJson.name}${subpath.slice(1)}`
    try {
      consumerRequire.resolve(specifier)
    } catch (error) {
      throw new Error(`unable to resolve declared runtime export ${specifier}`, {
        cause: error,
      })
    }
  }
  assert.throws(
    () => consumerRequire.resolve(`${packedPackageJson.name}/undeclared-subpath`),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "undeclared package subpaths must be blocked by the export map",
  )

  const optionalSurfacePeers = [
    "@medusajs/admin-sdk",
    "@medusajs/framework",
    "@medusajs/icons",
    "@medusajs/js-sdk",
    "@medusajs/medusa",
    "@medusajs/ui",
    "@tanstack/react-query",
    "react-i18next",
    "react-router-dom",
  ]
  for (const peer of optionalSurfacePeers) {
    if (packedPackageJson.peerDependenciesMeta?.[peer]?.optional !== true) {
      throw new Error(`packed package must keep surface-specific peer ${peer} optional`)
    }
  }
  for (const peer of ["react", "react-dom"]) {
    if (packedPackageJson.peerDependenciesMeta?.[peer]?.optional === true) {
      throw new Error(`packed package must require its storefront peer ${peer}`)
    }
  }

  const typeDependencies = new Set([
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.dependencies ?? {}),
    "@types/node",
    "@types/react",
    "@types/react-dom",
  ])
  for (const dependency of typeDependencies) {
    await linkInstalledPackage(dependency, consumerNodeModules)
  }

  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  )
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          // Medusa 2.18's own declarations currently require host ambient
          // BigNumber/Vite setup. Keep consumer code strict while treating
          // dependency declaration internals the same way Medusa starters do.
          skipLibCheck: true,
          esModuleInterop: true,
          jsx: "react-jsx",
          types: ["node", "react", "react-dom"],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    path.join(consumer, "consumer.ts"),
    `import digitalDownloadsModule, {
  DIGITAL_DOWNLOADS_MODULE,
  DigitalDownloadsModuleService,
  DigitalProductStatus,
  DigitalStorageProvider,
  ProtectedLocalStorageDriver,
  type CreateDigitalProductConfigInput,
  type DigitalDownloadsModuleOptions,
  type StorageDriver,
} from "@makecrypto/medusa-plugin-digital-downloads/modules/digital-downloads"
import legacyDigitalDownloadsModule from "@makecrypto/medusa-plugin-digital-downloads/.medusa/server/src/modules/digital-downloads"
import digitalFulfillmentProvider, {
  DigitalFulfillmentProviderService,
} from "@makecrypto/medusa-plugin-digital-downloads/providers/digital-fulfillment"
import {
  DIGITAL_DOWNLOAD_EVENTS,
  aggregateRefunds,
  createDigitalProductWorkflow,
  issueOrderEntitlementsWorkflow,
  orderTotalForRefundPolicy,
  registeredCustomerId,
  type CreateDigitalProductWorkflowInput,
  type IssueOrderEntitlementsWorkflowInput,
} from "@makecrypto/medusa-plugin-digital-downloads/workflows"
import {
  DigitalDownloadsProvider,
  createDigitalDownloadsFetchClient,
  type DigitalDownloadsClient,
  type DigitalLibraryQuery,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

type IsAny<T> = 0 extends 1 & T ? true : false
type AssertFalse<T extends false> = T
type _ModuleIsTyped = AssertFalse<IsAny<typeof DigitalDownloadsModuleService>>
type _WorkflowIsTyped = AssertFalse<IsAny<typeof createDigitalProductWorkflow>>

const options: DigitalDownloadsModuleOptions = {
  storage: {
    defaultProvider: DigitalStorageProvider.LOCAL,
    local: { rootPath: "/tmp/digital-downloads" },
  },
  defaultDownloadLimit: 3,
}
const product: CreateDigitalProductConfigInput = {
  title: "Typed product",
  status: DigitalProductStatus.DRAFT,
}
const workflowInput: CreateDigitalProductWorkflowInput = {
  variant_id: "variant_123",
  data: { title: product.title, status: product.status },
}
const issuanceInput: IssueOrderEntitlementsWorkflowInput = {
  order_id: "order_123",
  source: "payment.captured",
}
const driver: StorageDriver = new ProtectedLocalStorageDriver({
  rootPath: "/tmp/digital-downloads",
})
const client: DigitalDownloadsClient = createDigitalDownloadsFetchClient({
  baseUrl: "http://localhost:9000",
})
const query: DigitalLibraryQuery = { limit: 10 }

void options
void workflowInput
void issuanceInput
void driver
void client
void query
void digitalDownloadsModule
void legacyDigitalDownloadsModule
void digitalFulfillmentProvider
void DigitalFulfillmentProviderService.identifier
void DigitalDownloadsProvider
void DIGITAL_DOWNLOADS_MODULE
void DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_ISSUED
void aggregateRefunds({ refund_total: 0 })
void createDigitalProductWorkflow
void issueOrderEntitlementsWorkflow
void orderTotalForRefundPolicy({ total: 0 })
void registeredCustomerId({ customer_id: "cus_123", customer: { has_account: true } })
`,
  )

  const compiler = path.join(
    repositoryRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  )
  run(process.execPath, [compiler, "--project", "tsconfig.json"], consumer)
  process.stdout.write(
    `Packed TypeScript consumer passed (${packed.entryCount} files, ${packed.size} bytes).\n`,
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
