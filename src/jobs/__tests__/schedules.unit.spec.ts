import { config as cleanupConfig } from "../cleanup-digital-orphans"
import { config as expiryConfig } from "../expire-digital-entitlements"
import { config as fulfillmentConfig } from "../retry-digital-fulfillment"
import { config as notificationConfig } from "../retry-digital-notifications"

describe("digital download scheduled jobs", () => {
  it.each([
    cleanupConfig,
    expiryConfig,
    fulfillmentConfig,
    notificationConfig,
  ])("forbids overlapping runs for $name", (config) => {
    expect(config.schedule).toMatchObject({ concurrency: "forbid" })
    expect(config.schedule.cron).toMatch(/\S+/)
  })
})
