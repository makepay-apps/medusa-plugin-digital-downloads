import { readdirSync, statSync } from "node:fs"
import path from "node:path"

import { createApiKeysWorkflow } from "@medusajs/medusa/core-flows"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

// jsonwebtoken is a Medusa runtime dependency. Requiring it here avoids adding
// a package solely for signing a synthetic test actor token.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jwt = require("jsonwebtoken")

const httpFixtureRoot = path.resolve(__dirname)
const repositoryRoot = path.resolve(__dirname, "../..")
const builtPluginRoot = path.join(repositoryRoot, ".medusa", "server")

function newestMtime(root: string): number {
  const info = statSync(root)
  if (!info.isDirectory()) return info.mtimeMs
  return readdirSync(root, { withFileTypes: true }).reduce(
    (newest, entry) =>
      Math.max(newest, newestMtime(path.join(root, entry.name))),
    0,
  )
}

try {
  const buildMtime = newestMtime(builtPluginRoot)
  if (newestMtime(path.join(repositoryRoot, "src")) > buildMtime) {
    throw new Error("compiled plugin is older than src")
  }
} catch (error) {
  throw new Error(
    `HTTP integration requires a fresh packed-plugin build; run npm run build first (${(error as Error).message})`,
  )
}

medusaIntegrationTestRunner({
  moduleName: "digital-downloads-http",
  // Medusa's HTTP runner expects both values to be directories. Keeping its
  // project root beside this suite lets the fixture config load normally while
  // the plugin itself is resolved explicitly by that config.
  cwd: httpFixtureRoot,
  medusaConfigFile: httpFixtureRoot,
  env: {
    NODE_ENV: "test",
  },
  testSuite: ({ api, getContainer }) => {
    let adminHeaders: Record<string, string>
    let storeHeaders: Record<string, string>

    beforeAll(async () => {
      const container = getContainer()
      const userService = container.resolve("user") as any
      const authService = container.resolve("auth") as any
      const user = await userService.createUsers({
        email: "digital-downloads-http-admin@example.test",
      })
      const identity = await authService.createAuthIdentities({
        provider_identities: [
          {
            provider: "emailpass",
            entity_id: user.email,
            provider_metadata: { password: "synthetic-test-password" },
          },
        ],
        app_metadata: { user_id: user.id },
      })
      const token = jwt.sign(
        {
          actor_id: user.id,
          actor_type: "user",
          auth_identity_id: identity.id,
        },
        "http-integration-jwt-secret-32-bytes-minimum",
        { expiresIn: "10m" },
      )
      adminHeaders = { authorization: `Bearer ${token}` }
      const publishableKey = (
        await createApiKeysWorkflow(container).run({
          input: {
            api_keys: [
              {
                type: "publishable",
                title: "Digital downloads HTTP fixture",
                created_by: user.id,
              },
            ],
          },
        })
      ).result[0]
      storeHeaders = { "x-publishable-api-key": publishableKey.token }
    })

    describe("digital downloads HTTP surface", () => {
      it("loads the packaged metadata route with the exact fixed attribution", async () => {
        const response = await api.get("/store/digital-downloads", {
          headers: storeHeaders,
        })

        expect(response.status).toBe(200)
        expect(response.data.plugin).toMatchObject({
          id: "medusa-plugin-digital-downloads",
          version: "0.3.1",
          attribution: {
            text: "Brought to you by MakePay.io — crypto payment gateway.",
            url: "https://makepay.io",
          },
        })
        expect(response.headers["cache-control"]).toContain("max-age=300")
      })

      it("rejects unauthenticated Admin and customer-library requests", async () => {
        const [admin, library] = await Promise.all([
          api.get("/admin/digital-downloads/settings", {
            validateStatus: () => true,
          }),
          api.get("/store/digital-downloads/library", {
            headers: storeHeaders,
            validateStatus: () => true,
          }),
        ])

        expect(admin.status).toBe(401)
        expect(library.status).toBe(401)
      })

      it("returns ready settings to an Admin without exposing runtime secrets", async () => {
        const response = await api.get("/admin/digital-downloads/settings", {
          headers: adminHeaders,
          validateStatus: () => true,
        })

        expect(response.status).toBe(200)
        expect(response.data.settings).toMatchObject({
          enabled: true,
          storage: { provider: "local", configured: true },
          readiness: { ready: true },
        })
        const serialized = JSON.stringify(response.data)
        expect(serialized).not.toContain(
          "http-integration-token-secret-32-bytes-minimum",
        )
        expect(serialized).not.toContain(
          "3".repeat(64),
        )
        expect(serialized).not.toContain(
          "http-integration-signing-secret-32-bytes-minimum",
        )
      })

      it("rejects malformed guest capabilities before service lookup", async () => {
        const response = await api.post(
          "/store/digital-downloads/guest/access",
          { token: "short" },
          { headers: storeHeaders, validateStatus: () => true },
        )

        expect(response.status).toBe(400)
        expect(JSON.stringify(response.data)).not.toContain("token_hash")
      })

      it("rejects grant capabilities in query strings", async () => {
        const response = await api.get(
          "/store/digital-downloads/content/asset_fixture?token=not-allowed",
          { headers: storeHeaders, validateStatus: () => true },
        )

        expect(response.status).toBe(400)
        expect(response.data).toMatchObject({ code: "token_in_query_not_allowed" })
      })

      it("hides unknown public variant mappings", async () => {
        const response = await api.get(
          "/store/digital-downloads/products/variant_does_not_exist",
          { headers: storeHeaders, validateStatus: () => true },
        )

        expect(response.status).toBe(404)
      })
    })
  },
})

jest.setTimeout(120_000)
