import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"

import {
  getPublicProduct,
} from "../lib/store-handlers"
import {
  licenseLifecycleReply,
  safeAdmin,
  safeEntitlement,
} from "../lib/projections"

function response() {
  const res: any = {
    headers: {} as Record<string, string>,
    payload: undefined,
  }
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers[name] = value
    return res
  })
  res.json = jest.fn((payload: unknown) => {
    res.payload = payload
    return res
  })
  return res
}

describe("frozen storefront DTO contract", () => {
  it("normalizes a native DigitalProduct and its nested current release", async () => {
    const digitalDownloads = {
      retrieveDigitalProductConfig: jest.fn().mockResolvedValue({
        id: "dprod_1",
        title: "Studio album",
        status: "active",
        delivery_type: "stream",
        releases: [
          {
            id: "drel_1",
            version: "1.0.0",
            status: "published",
            is_current: true,
            published_at: "2026-07-31T00:00:00.000Z",
            assets: [
              {
                id: "dasset_audio",
                role: "stream",
                kind: "audio",
                status: "ready",
                is_enabled: true,
                delivery_type: "stream",
                name: "Album FLAC",
                original_filename: "album.flac",
                mime_type: "audio/flac",
                size_bytes: 42,
                storage_key: "private/album.flac",
              },
              {
                id: "dasset_preview",
                role: "preview",
                kind: "audio",
                status: "ready",
                is_enabled: true,
                name: "Listen",
                mime_type: "audio/mpeg",
                size_bytes: 7,
                storage_key: "private/preview.mp3",
              },
              {
                id: "dasset_cover",
                role: "cover",
                kind: "image",
                status: "ready",
                is_enabled: true,
                name: "Cover",
                mime_type: "image/jpeg",
                size_bytes: 3,
                storage_key: "private/cover.jpg",
              },
            ],
          },
        ],
      }),
    }
    const linkService = {
      list: jest.fn().mockResolvedValue([
        { variant_id: "variant_1", digital_product_id: "dprod_1" },
      ]),
    }
    const link = { getLinkModule: jest.fn(() => linkService) }
    const product = {
      retrieveProductVariant: jest.fn().mockResolvedValue({
        id: "variant_1",
        title: "Lossless",
        product_id: "prod_1",
        product: { id: "prod_1", title: "Studio album" },
      }),
    }
    const req: any = {
      params: { variant_id: "variant_1" },
      query: {},
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "digitalDownloads") return digitalDownloads
          if (key === ContainerRegistrationKeys.LINK) return link
          if (key === Modules.PRODUCT) return product
          throw new Error(`Unexpected registration: ${key}`)
        }),
      },
    }
    const res = response()

    await getPublicProduct(req, res)

    expect(link.getLinkModule).toHaveBeenCalledWith(
      Modules.PRODUCT,
      "product_variant_id",
      "digitalDownloads",
      "digital_product_id",
    )
    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: "variant_1" },
      { take: 1 },
    )
    expect(res.payload).toEqual({
      product: expect.objectContaining({
        product_id: "prod_1",
        variant_id: "variant_1",
        variant_title: "Lossless",
        kind: "audio",
        delivery_types: ["stream"],
        file_count: 1,
        total_size_bytes: 42,
        previews: [
          expect.objectContaining({
            id: "dasset_preview",
            kind: "audio",
            url: "/store/digital-downloads/previews/dasset_preview",
          }),
          expect.objectContaining({
            id: "dasset_cover",
            kind: "image",
            url: "/store/digital-downloads/previews/dasset_cover",
          }),
        ],
      }),
    })
    expect(JSON.stringify(res.payload)).not.toMatch(/storage_key|private\//)
  })

  it("returns not found for an unmapped public variant without querying product data", async () => {
    const digitalDownloads = {
      retrieveDigitalProductConfig: jest.fn(),
    }
    const linkService = { list: jest.fn().mockResolvedValue([]) }
    const link = { getLinkModule: jest.fn(() => linkService) }
    const product = { retrieveProductVariant: jest.fn() }
    const req: any = {
      params: { variant_id: "variant_missing" },
      query: {},
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === "digitalDownloads") return digitalDownloads
          if (key === ContainerRegistrationKeys.LINK) return link
          if (key === Modules.PRODUCT) return product
          throw new Error(`Unexpected registration: ${key}`)
        }),
      },
    }

    await expect(getPublicProduct(req, response())).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: "variant_missing" },
      { take: 1 },
    )
    expect(digitalDownloads.retrieveDigitalProductConfig).not.toHaveBeenCalled()
    expect(product.retrieveProductVariant).not.toHaveBeenCalled()
  })

  it("projects entitlements exactly as the storefront SDK consumes them", () => {
    const projected = safeEntitlement({
      id: "dent_1",
      status: "active",
      order_id: "order_1",
      order_line_item_id: "item_1",
      unit_index: 0,
      created_at: "2026-07-31T00:00:00.000Z",
      available_at: "2026-07-31T00:00:00.000Z",
      download_limit: 3,
      download_count: 1,
      customer_id: "cus_private",
      snapshot: {
        order: { id: "order_1", display_id: 1042 },
        line_item: {
          id: "item_1",
          product_id: "prod_1",
          variant_id: "variant_1",
          title: "Guide",
          subtitle: "PDF",
        },
        digital_product: { kind: "pdf", delivery_mode: "download" },
      },
      release: {
        assets: [
          {
            id: "dasset_1",
            role: "download",
            kind: "pdf",
            name: "Guide",
            original_filename: "guide.pdf",
            mime_type: "application/pdf",
            size_bytes: 1024,
            delivery_type: "download",
            storage_key: "private/guide.pdf",
          },
        ],
      },
      license_assignments: [
        {
          id: "dlassn_1",
          status: "active",
          assigned_at: "2026-07-31T00:00:00.000Z",
          key_ciphertext: "secret",
          activations: [],
        },
      ],
    })

    expect(Object.keys(projected).sort()).toEqual(
      [
        "assets",
        "capabilities",
        "created_at",
        "expires_at",
        "granted_at",
        "id",
        "license",
        "line_item_id",
        "order_id",
        "order_display_id",
        "product",
        "revoked_at",
        "status",
        "status_reason",
        "unit_index",
      ].sort(),
    )
    expect(projected).toMatchObject({
      product: {
        product_id: "prod_1",
        variant_id: "variant_1",
        title: "Guide",
        variant_title: "PDF",
        kind: "ebook",
      },
      order_display_id: 1042,
      assets: [
        {
          id: "dasset_1",
          title: "Guide",
          filename: "guide.pdf",
          kind: "ebook",
          delivery_types: ["download"],
        },
      ],
      license: {
        id: "dlassn_1",
        status: "active",
        activations: [],
      },
      capabilities: {
        can_download: true,
        can_stream: false,
        can_reveal_license: true,
        can_activate_license: true,
        can_deactivate_license: false,
      },
    })
    expect(JSON.stringify(projected)).not.toMatch(
      /customer_id|storage_key|key_ciphertext|private\//,
    )
  })

  it("never returns activation fingerprints or request hashes", () => {
    const reply = licenseLifecycleReply({
      assignment: { id: "dlassn_1", status: "active" },
      activation: {
        id: "dlact_1",
        status: "active",
        device_name: "Laptop",
        device_fingerprint: "private-device-digest",
        ip_hash: "private-ip-digest",
        user_agent_hash: "private-agent-digest",
        activated_at: "2026-07-31T00:00:00.000Z",
      },
    })

    expect(reply).toMatchObject({
      license: { id: "dlassn_1", activations: [{ id: "dlact_1" }] },
      activation: { id: "dlact_1", name: "Laptop" },
    })
    expect(JSON.stringify(reply)).not.toMatch(/fingerprint|ip_hash|user_agent/)
  })

  it("recursively removes internal key and request fingerprints", () => {
    expect(
      safeAdmin({
        id: "dlkey_1",
        key_fingerprint: "private-key-digest",
        checksum_sha256: "public-integrity-checksum",
        metadata: { request_fingerprint: "private-retry-digest" },
      }),
    ).toEqual({
      id: "dlkey_1",
      checksum_sha256: "public-integrity-checksum",
      metadata: {},
    })
  })
})
