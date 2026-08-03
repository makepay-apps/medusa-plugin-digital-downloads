/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { createElement } from "react"
import { ReadableStream } from "node:stream/web"
import type { DigitalDownloadsClient } from "../client"
import {
  DigitalDownloadsProvider,
  DigitalLibrary,
  DigitalOrderDownloads,
  DigitalProductPreviews,
  MAX_BROWSER_GRANT_BYTES,
  MakePayAttribution,
  prepareDigitalAccessGrant,
  useDigitalEntitlement,
  useDigitalLibrary,
} from "../react"
import type {
  DigitalAccessGrant,
  DigitalEntitlement,
  DigitalLibraryResponse,
  DigitalProductPreviewResponse,
} from "../types"

const entitlement: DigitalEntitlement = {
  id: "ent_1",
  status: "active",
  order_id: "order_1",
  order_display_id: 42,
  line_item_id: "item_1",
  created_at: "2026-01-01T00:00:00.000Z",
  granted_at: "2026-01-02T00:00:00.000Z",
  product: {
    title: "Ambient collection",
    variant_title: "Lossless",
    kind: "audio",
  },
  assets: [
    {
      id: "asset_1",
      title: "Album (FLAC)",
      filename: "album.flac",
      kind: "audio",
      mime_type: "audio/flac",
      size_bytes: 1_500_000,
      delivery_types: ["download", "stream"],
    },
  ],
  license: {
    id: "license_1",
    status: "active",
    masked_key: "••••-ABCD",
    max_activations: 2,
    activations: [],
  },
  capabilities: {
    can_download: true,
    can_stream: true,
    can_reveal_license: true,
    can_activate_license: true,
    can_deactivate_license: true,
  },
}

const library: DigitalLibraryResponse = {
  entitlements: [entitlement],
  count: 1,
  limit: 20,
  offset: 0,
}

const secondEntitlement: DigitalEntitlement = {
  ...entitlement,
  id: "ent_2",
  order_id: "order_2",
  order_display_id: 43,
  product: {
    ...entitlement.product,
    title: "Second customer's collection",
  },
}

const secondLibrary: DigitalLibraryResponse = {
  ...library,
  entitlements: [secondEntitlement],
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const accessGrant = (
  action: "download" | "stream",
  mimeType: string,
  size: number
): DigitalAccessGrant => ({
  token: "grant-secret",
  asset_id: "asset_1",
  action,
  method: "GET",
  url: "https://medusa.example/content/asset_1",
  headers: { authorization: "Bearer grant-secret" },
  expires_at: "2030-01-01T00:00:00.000Z",
  filename: "asset.bin",
  mime_type: mimeType,
  size_bytes: size,
  supports_ranges: true,
})

const contentResponse = (
  body: Uint8Array | null,
  headers: Record<string, string>
): Response => {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  )
  return {
    body: body
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body)
            controller.close()
          },
        })
      : null,
    headers: {
      get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
  } as unknown as Response
}

const createClient = (
  overrides: Partial<DigitalDownloadsClient> = {}
): DigitalDownloadsClient =>
  ({
    getProductPreview: jest.fn(),
    listLibrary: jest.fn(async () => library),
    getEntitlement: jest.fn(),
    getGuestAccess: jest.fn(),
    requestAccessGrant: jest.fn(),
    requestGuestAccessGrant: jest.fn(),
    requestDownloadGrant: jest.fn(async () => ({
      grant: {
        token: "grant-secret",
        asset_id: "asset_1",
        action: "download",
        method: "GET",
        url: "https://medusa.example/content/asset_1",
        headers: { authorization: "Bearer grant-secret" },
        expires_at: "2030-01-01T00:00:00.000Z",
        filename: "album.flac",
        supports_ranges: true,
      },
    })),
    requestStreamGrant: jest.fn(),
    revealLicense: jest.fn(async () => ({ license_key: "AAAA-BBBB-CCCC" })),
    activateLicense: jest.fn(),
    deactivateLicense: jest.fn(),
    heartbeatLicense: jest.fn(),
    validateLicense: jest.fn(),
    ...overrides,
  }) as DigitalDownloadsClient

describe("storefront React primitives", () => {
  it("renders the restrained MakePay attribution with a fixed HTTPS link", () => {
    render(createElement(MakePayAttribution))

    const footer = document.querySelector("[data-makepay-attribution]") as HTMLElement
    const link = screen.getByRole("link", { name: "MakePay.io" })
    expect(footer.textContent).toContain(
      "Brought to you by MakePay.io — crypto payment gateway."
    )
    expect(link.getAttribute("href")).toBe("https://makepay.io")
    expect(footer.style.opacity).toBe("0.65")
  })

  it("renders accessible public audio previews and attribution", async () => {
    const response: DigitalProductPreviewResponse = {
      product: {
        product_id: "prod_1",
        variant_id: "variant_1",
        title: "Ambient collection",
        kind: "audio",
        delivery_types: ["download", "stream"],
        previews: [
          {
            id: "preview_1",
            kind: "audio",
            title: "Track sample",
            mime_type: "audio/mpeg",
            url: "https://medusa.example/previews/preview_1",
          },
        ],
      },
    }
    const client = createClient({
      getProductPreview: jest.fn(async () => response),
    })

    render(
      createElement(DigitalProductPreviews, { client, variantId: "variant_1" })
    )

    expect(screen.getByRole("status").textContent).toContain("Loading")
    await waitFor(() =>
      expect(screen.getByLabelText("Track sample").getAttribute("src")).toBe(
        "https://medusa.example/previews/preview_1"
      )
    )
    expect(screen.getByRole("link", { name: "MakePay.io" })).toBeTruthy()
  })

  it("renders a library and sends a requested grant to the host callback", async () => {
    const client = createClient()
    const onGrant = jest.fn()

    render(
      createElement(DigitalLibrary, {
        client,
        identityKey: "customer-1",
        initialData: library,
        onGrant,
      })
    )

    expect(
      screen.getByRole("heading", { name: "Your digital library" })
    ).toBeTruthy()
    expect(screen.getByRole("article").getAttribute("data-status")).toBe("active")
    expect(screen.getByText("Album (FLAC)").parentElement?.textContent).toContain(
      "1.5 MB"
    )

    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    await waitFor(() => expect(onGrant).toHaveBeenCalledTimes(1))
    expect(onGrant.mock.calls[0][0]).toMatchObject({
      token: "grant-secret",
      action: "download",
    })
  })

  it("renders native order delivery with a friendly reference and an enforced order scope", async () => {
    const listLibrary = jest.fn(async () => library)
    const client = createClient({ listLibrary })
    const queryWithForeignOrder = {
      order_id: "order_other",
      status: "active" as const,
    } as unknown as { status: "active" }

    render(
      createElement(DigitalOrderDownloads, {
        client,
        identityKey: "customer-1",
        orderDisplayId: 42,
        orderId: " order_1 ",
        query: queryWithForeignOrder,
        showAttribution: false,
      })
    )

    expect(
      screen.getByRole("heading", {
        name: "Downloads & licenses for order #42",
      })
    ).toBeTruthy()
    await screen.findByText("Ambient collection")
    expect(screen.getByText("#42")).toBeTruthy()
    expect(listLibrary).toHaveBeenCalledWith(
      { order_id: "order_1", status: "active" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("rejects a blank order ID before loading an order library", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(() =>
        render(
          createElement(DigitalOrderDownloads, {
            client: createClient(),
            identityKey: "customer-1",
            orderId: "   ",
          })
        )
      ).toThrow("orderId is required")
    } finally {
      error.mockRestore()
    }
  })

  it("reveals a license only after an explicit buyer action", async () => {
    const revealLicense = jest.fn(async () => ({ license_key: "AAAA-BBBB-CCCC" }))
    const client = createClient({ revealLicense })

    render(
      createElement(DigitalLibrary, {
        client,
        identityKey: "customer-1",
        initialData: library,
      })
    )

    expect(screen.queryByText("AAAA-BBBB-CCCC")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Reveal license key" }))
    await waitFor(() => expect(screen.getByText("AAAA-BBBB-CCCC")).toBeTruthy())
    expect(revealLicense).toHaveBeenCalledWith("license_1", {}, undefined)

    fireEvent.click(screen.getByRole("button", { name: "Hide license key" }))
    expect(screen.queryByText("AAAA-BBBB-CCCC")).toBeNull()
  })

  it("uses guest endpoints instead of customer library and grant endpoints", async () => {
    const getGuestAccess = jest.fn(async () => ({ entitlement }))
    const requestGuestAccessGrant = jest.fn(async () => ({
      grant: {
        token: "guest-grant",
        asset_id: "asset_1",
        action: "download" as const,
        method: "GET" as const,
        url: "https://medusa.example/content/asset_1",
        headers: { authorization: "Bearer guest-grant" },
        expires_at: "2030-01-01T00:00:00.000Z",
        supports_ranges: true,
      },
    }))
    const listLibrary = jest.fn(async () => library)
    const client = createClient({
      getGuestAccess,
      listLibrary,
      requestGuestAccessGrant,
    })
    const onGrant = jest.fn()

    render(
      createElement(DigitalLibrary, {
        access: {
          guest_token: "guest-secret",
          guest_email: "buyer@example.test",
        },
        client,
        onGrant,
      })
    )

    await waitFor(() =>
      expect(getGuestAccess).toHaveBeenCalledWith(
        { token: "guest-secret", email: "buyer@example.test" },
        expect.anything(),
      ),
    )
    expect(listLibrary).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole("button", { name: "Download" }))
    await waitFor(() => expect(onGrant).toHaveBeenCalledTimes(1))
    expect(requestGuestAccessGrant).toHaveBeenCalledWith(
      {
        token: "guest-secret",
        email: "buyer@example.test",
        entitlement_id: "ent_1",
        asset_id: "asset_1",
        action: "download",
      },
      undefined
    )
  })

  it("requires an explicit identity key for enabled customer resources", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(() =>
        renderHook(() => useDigitalLibrary({ client: createClient() }))
      ).toThrow("customer flows require identityKey")
    } finally {
      error.mockRestore()
    }
  })

  it("clears customer library state immediately across provider identity changes", async () => {
    const replacement = deferred<DigitalLibraryResponse>()
    const listLibrary = jest
      .fn<Promise<DigitalLibraryResponse>, []>()
      .mockResolvedValueOnce(library)
      .mockImplementationOnce(() => replacement.promise)
    const client = createClient({ listLibrary })
    const view = (identityKey: string) =>
      createElement(
        DigitalDownloadsProvider,
        { client, identityKey },
        createElement(DigitalLibrary)
      )
    const rendered = render(view("customer-1"))

    await screen.findByText("Ambient collection")
    rendered.rerender(view("customer-2"))

    expect(screen.queryByText("Ambient collection")).toBeNull()
    expect(screen.getByRole("status").textContent).toContain("Loading")

    await act(async () => replacement.resolve(secondLibrary))
    await screen.findByText("Second customer's collection")
  })

  it("clears guest entitlement state immediately when the capability changes", async () => {
    const replacement = deferred<{ entitlement: DigitalEntitlement }>()
    const getGuestAccess = jest
      .fn<Promise<{ entitlement: DigitalEntitlement }>, [string, unknown?]>()
      .mockResolvedValueOnce({ entitlement })
      .mockImplementationOnce(() => replacement.promise)
    const client = createClient({ getGuestAccess })
    const { result, rerender } = renderHook(
      ({ token }) =>
        useDigitalEntitlement({
          access: { guest_token: token },
          client,
          entitlementId: token === "guest-a" ? "ent_1" : "ent_2",
        }),
      { initialProps: { token: "guest-a" } }
    )

    await waitFor(() => expect(result.current.entitlement?.id).toBe("ent_1"))
    rerender({ token: "guest-b" })

    expect(result.current.entitlement).toBeUndefined()
    expect(result.current.isLoading).toBe(true)

    await act(async () => replacement.resolve({ entitlement: secondEntitlement }))
    await waitFor(() => expect(result.current.entitlement?.id).toBe("ent_2"))
  })

  it("clears library state immediately on client changes and disablement", async () => {
    const firstClient = createClient({
      listLibrary: jest.fn(async () => library),
    })
    const replacement = deferred<DigitalLibraryResponse>()
    const secondClient = createClient({
      listLibrary: jest.fn(() => replacement.promise),
    })
    const { result, rerender } = renderHook(
      ({ client, enabled }) =>
        useDigitalLibrary({
          client,
          enabled,
          identityKey: "customer-1",
        }),
      { initialProps: { client: firstClient, enabled: true } }
    )

    await waitFor(() => expect(result.current.entitlements[0]?.id).toBe("ent_1"))
    rerender({ client: secondClient, enabled: true })
    expect(result.current.entitlements).toEqual([])
    expect(result.current.isLoading).toBe(true)

    rerender({ client: secondClient, enabled: false })
    expect(result.current.entitlements).toEqual([])
    expect(result.current.isLoading).toBe(false)

    await act(async () => replacement.resolve(secondLibrary))
    expect(result.current.entitlements).toEqual([])
  })

  it("bounds browser grant reads and forces active download content to octet-stream", async () => {
    const body = new Uint8Array(Buffer.from("<script>unsafe()</script>"))
    const prepared = await prepareDigitalAccessGrant(
      accessGrant("download", "text/html", body.byteLength),
      contentResponse(body, {
        "content-length": String(body.byteLength),
        "content-type": "text/html",
      })
    )

    expect(prepared.openInline).toBe(false)
    expect(prepared.mimeType).toBe("application/octet-stream")
    expect(prepared.blob.type).toBe("application/octet-stream")
    expect(prepared.size).toBe(body.byteLength)

    await expect(
      prepareDigitalAccessGrant(
        accessGrant("download", "application/octet-stream", MAX_BROWSER_GRANT_BYTES + 1),
        contentResponse(null, {
          "content-length": String(MAX_BROWSER_GRANT_BYTES + 1),
          "content-type": "application/octet-stream",
        })
      )
    ).rejects.toMatchObject({ code: "browser_content_too_large" })
  })

  it("opens only length-matched allowlisted media inline", async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const prepared = await prepareDigitalAccessGrant(
      accessGrant("stream", "audio/mpeg", body.byteLength),
      contentResponse(body, {
        "content-length": String(body.byteLength),
        "content-type": "audio/mpeg",
      })
    )

    expect(prepared.openInline).toBe(true)
    expect(prepared.blob.type).toBe("audio/mpeg")

    await expect(
      prepareDigitalAccessGrant(
        accessGrant("stream", "image/svg+xml", body.byteLength),
        contentResponse(body, {
          "content-length": String(body.byteLength),
          "content-type": "image/svg+xml",
        })
      )
    ).rejects.toMatchObject({ code: "unsafe_inline_content_type" })

    await expect(
      prepareDigitalAccessGrant(
        accessGrant("stream", "audio/mpeg", body.byteLength + 1),
        contentResponse(body, {
          "content-length": String(body.byteLength + 1),
          "content-type": "audio/mpeg",
        })
      )
    ).rejects.toMatchObject({ code: "content_length_mismatch" })
  })
})
