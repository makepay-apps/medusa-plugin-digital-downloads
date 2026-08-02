import { defineConfig } from "eslint/config"
import medusa from "@medusajs/eslint-plugin"

export default defineConfig([
  ...medusa.configs.recommended,
  {
    files: [
      "scripts/**/*.{js,ts}",
      "src/modules/digital-downloads/storage/**/*.ts",
      "src/modules/digital-downloads/utils/crypto.ts",
      "src/modules/digital-downloads/utils/license-pattern.ts",
    ],
    rules: {
      // These framework-independent boundaries intentionally throw ordinary
      // errors. The module/API layers translate them into Medusa HTTP errors;
      // importing MedusaError here would couple storage, crypto, and tooling to
      // the request layer and would make provider-error sanitization less clear.
      "@medusajs/use-medusa-error-not-generic-error": "off",
    },
  },
])
