import path from "node:path"

import { defineConfig, loadEnv } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "test", process.cwd())

const repositoryRoot = path.resolve(__dirname, "../..")
const localRoot =
  process.env.DIGITAL_DOWNLOADS_HTTP_STORAGE_ROOT ??
  path.join(__dirname, ".tmp", `http-storage-${process.pid}`)

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: "http://127.0.0.1:8000",
      adminCors: "http://127.0.0.1:7001",
      authCors: "http://127.0.0.1:7001,http://127.0.0.1:8000",
      jwtSecret: "http-integration-jwt-secret-32-bytes-minimum",
      cookieSecret: "http-integration-cookie-secret-32-bytes-minimum",
    },
  },
  plugins: [
    {
      // Exercise the complete built plugin (routes, middleware, links, and
      // module), rather than booting only its service module.
      resolve: repositoryRoot,
      options: {
        tokenSecret: "http-integration-token-secret-32-bytes-minimum",
        encryptionKey: "3".repeat(64),
        storage: {
          defaultProvider: "local",
          local: {
            rootPath: localRoot,
            signingSecret:
              "http-integration-signing-secret-32-bytes-minimum",
          },
        },
      },
    },
  ],
})
