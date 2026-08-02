import { readFile } from "node:fs/promises"

const path = process.argv[2]
if (!path) throw new Error("Usage: node scripts/verify-sbom.mjs <sbom.json>")

const document = JSON.parse(await readFile(path, "utf8"))
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
)
if (document.bomFormat !== "CycloneDX" || document.specVersion !== "1.6") {
  throw new Error("Release SBOM must be a CycloneDX 1.6 document")
}
if (document.metadata?.component?.type !== "library") {
  throw new Error("Release SBOM root component must be a library")
}
const [expectedGroup, expectedName] = packageJson.name.startsWith("@")
  ? packageJson.name.split("/")
  : [undefined, packageJson.name]
const rootComponent = document.metadata?.component
if (
  rootComponent?.name !== expectedName ||
  rootComponent?.group !== expectedGroup ||
  rootComponent?.version !== packageJson.version ||
  rootComponent?.["bom-ref"] !== `${packageJson.name}@${packageJson.version}`
) {
  throw new Error("Release SBOM root identity must match package.json exactly")
}

const components = Array.isArray(document.components)
  ? document.components
  : []
const requiredPurlPrefixes = [
  "pkg:npm/%40aws-sdk/client-s3@",
  "pkg:npm/%40aws-sdk/s3-request-presigner@",
]
for (const prefix of requiredPurlPrefixes) {
  if (!components.some((component) => component?.purl?.startsWith(prefix))) {
    throw new Error(`Release SBOM is missing runtime component ${prefix}`)
  }
}

const rootRef = document.metadata?.component?.["bom-ref"]
const rootDependency = Array.isArray(document.dependencies)
  ? document.dependencies.find((entry) => entry?.ref === rootRef)
  : undefined
if (!rootDependency || rootDependency.dependsOn?.length !== 2) {
  throw new Error("Release SBOM root must depend on both direct runtime packages")
}
