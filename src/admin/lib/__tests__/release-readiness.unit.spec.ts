import { hasPublishableReleaseDeliverables } from "../release-readiness"

const release = (assets: Array<Record<string, unknown>> = []) =>
  ({
    id: "drel_1",
    product_config_id: "dprod_1",
    version: "1.0.0",
    status: "draft",
    created_at: "2026-08-03T00:00:00.000Z",
    assets,
  }) as any

describe("Admin release readiness", () => {
  it("allows a zero-asset license release only with an enabled supported policy", () => {
    for (const strategy of ["generated", "pool"] as const) {
      expect(
        hasPublishableReleaseDeliverables({
          deliveryType: "license",
          licensePolicy: {
            id: "dlpol_1",
            strategy,
            is_enabled: true,
          },
          release: release(),
        })
      ).toBe(true)
    }

    expect(
      hasPublishableReleaseDeliverables({
        deliveryType: "license",
        licensePolicy: {
          id: "dlpol_1",
          strategy: "generated",
          is_enabled: false,
        },
        release: release(),
      })
    ).toBe(false)
    expect(
      hasPublishableReleaseDeliverables({
        deliveryType: "license",
        licensePolicy: null,
        release: release(),
      })
    ).toBe(false)
    expect(
      hasPublishableReleaseDeliverables({
        deliveryType: "license",
        licensePolicy: null,
        release: release([
          {
            id: "dasset_license",
            role: "license",
            status: "ready",
            is_enabled: true,
          },
        ]),
      })
    ).toBe(false)
  })

  it("keeps empty and preview-only download releases blocked", () => {
    const input = {
      deliveryType: "download" as const,
      licensePolicy: null,
    }
    expect(
      hasPublishableReleaseDeliverables({ ...input, release: release() })
    ).toBe(false)
    expect(
      hasPublishableReleaseDeliverables({
        ...input,
        release: release([
          {
            id: "dasset_preview",
            role: "preview",
            status: "ready",
            is_enabled: true,
          },
        ]),
      })
    ).toBe(false)
    expect(
      hasPublishableReleaseDeliverables({
        ...input,
        release: release([
          {
            id: "dasset_download",
            role: "download",
            status: "ready",
            is_enabled: true,
          },
        ]),
      })
    ).toBe(true)
  })

  it("requires both content and licensing for mixed delivery", () => {
    const policy = {
      id: "dlpol_1",
      strategy: "generated" as const,
      is_enabled: true,
    }
    expect(
      hasPublishableReleaseDeliverables({
        deliveryType: "mixed",
        licensePolicy: policy,
        release: release(),
      })
    ).toBe(false)
    expect(
      hasPublishableReleaseDeliverables({
        deliveryType: "mixed",
        licensePolicy: policy,
        release: release([
          {
            id: "dasset_download",
            role: "download",
            status: "ready",
            is_enabled: true,
          },
        ]),
      })
    ).toBe(true)
  })
})
