const { loadEnv } = require("@medusajs/framework/utils")

loadEnv("test", process.cwd())

module.exports = {
  clearMocks: true,
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/admin/**",
    "!src/**/index.ts",
    "!src/**/*.d.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  moduleFileExtensions: ["js", "ts", "tsx", "json"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  modulePathIgnorePatterns: ["<rootDir>/.medusa/", "<rootDir>/dist/"],
  setupFiles: ["<rootDir>/integration-tests/setup.js"],
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true, tsx: true },
          target: "es2021",
          transform: { react: { runtime: "automatic" } },
        },
      },
    ],
  },
}

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = [
    "**/src/modules/*/__tests__/**/*.integration.spec.[jt]s",
    "**/integration-tests/modules/**/*.integration.spec.[jt]s",
  ]
} else {
  module.exports.testMatch = [
    "**/src/**/__tests__/**/*.unit.spec.[jt]s",
    "**/tests/**/*.unit.spec.[jt]s",
  ]
}
