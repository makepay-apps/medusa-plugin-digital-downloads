# Storefront SDK

The `@makecrypto/medusa-plugin-digital-downloads/storefront` export combines a
transport-independent client with the supplied React components. The client can
use native `fetch`, an existing Medusa JS SDK client, or a custom transport;
React 18 or 19 is a package peer because the same export also exposes the UI
primitives.

## Native fetch

```ts
import {
  createDigitalDownloadsFetchClient,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

const digitalDownloads = createDigitalDownloadsFetchClient({
  baseUrl: "http://localhost:9000",
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  authToken: () => customerToken,
})

const { product } = await digitalDownloads.getProductPreview("variant_123")
const { entitlements } = await digitalDownloads.listLibrary({ limit: 20 })
```

`authToken` can be asynchronous and is resolved for every request, which makes
rotation and server-request cookie lookup safe. Private calls always use
`cache: "no-store"`.

## Existing Medusa JS SDK

```ts
import {
  createDigitalDownloadsClient,
  createMedusaSdkTransport,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

const digitalDownloads = createDigitalDownloadsClient({
  transport: createMedusaSdkTransport(sdk.client, {
    headers: async () => getAuthHeaders(),
  }),
})
```

The adapter is structural and does not add a dependency on a specific
`@medusajs/js-sdk` version.

## Customer and guest access

Customer library and entitlement routes use Medusa's normal customer bearer.
An opaque guest purchase token is a separate capability and is sent only in a
POST JSON body:

```ts
const { entitlement } = await digitalDownloads.getGuestAccess({
  token: guestToken,
  email: orderEmail,
})

const { grant } = await digitalDownloads.requestGuestAccessGrant({
  token: guestToken,
  email: orderEmail,
  entitlement_id: entitlement.id,
  asset_id: entitlement.assets[0].id,
  action: "download",
})
```

Guest tokens are never put in URLs or headers by this SDK. Applications should
keep them in memory or an encrypted/HttpOnly server session. For magic links,
prefer a URL fragment, capture and remove it immediately, then prompt for the
order email before exchange. The `require_order_email_match` setting defaults
to `true`, so send that email in guest access/grant requests; do not embed it in
the link.

## Protected content

Grant tokens are short-lived Authorization bearers. The client normalizes the
wire grant into a fetch-ready object and `fetchDigitalAccessGrant` supports
range requests without leaking the bearer in a URL:

```ts
const response = await fetchDigitalAccessGrant(grant, {
  range: "bytes=0-1048575",
})

// Pipe response.body, save it, or proxy it through your storefront backend.
```

Protected delivery commits grant/download consumption before the first response
byte, then streams with backpressure and buffers no response body. The supplied
React library's dependency-free object-URL opener is deliberately limited to
64 MiB, validates actual length and MIME, opens only allowlisted audio/video
inline, and forces downloads to `application/octet-stream`. Large files and
seekable audio/video should use `onGrant` with a same-origin BFF or media-session
endpoint, as shown in `examples/nextjs-starter`.

## React

```tsx
<DigitalDownloadsProvider
  client={digitalDownloads}
  identityKey={customerIdentityKey}
>
  <DigitalProductPreviews variantId={variant.id} />
  <DigitalLibrary identityKey={customerIdentityKey} />
</DigitalDownloadsProvider>
```

Customer resources require a non-secret `identityKey` that changes on login,
logout, or account/session switch so data from one actor is never retained for
the next. Guest resources instead pass
`access={{ guest_token, guest_email: orderEmail }}`; the reveal action forwards
the guest email as `guest_email` automatically.

Available hooks are `useDigitalProductPreview`, `useDigitalLibrary`,
`useDigitalEntitlement`, `useDigitalEntitlementActions`, and
`useDigitalLicense`. Components use semantic headings, lists, native buttons,
status/alert live regions, labelled media, and keyboard-native controls.

`DigitalProductPreviews` and `DigitalLibrary` show a restrained
“Brought to you by MakePay.io — crypto payment gateway.” footer by default. Set
`showAttribution={false}` to opt out or render `MakePayAttribution` directly.
The attribution destination is fixed to `https://makepay.io`.

## Store API contract

The client is aligned to this v1 contract. All private JSON responses and all
license lifecycle responses must include `Cache-Control: private, no-store`.

| Method | Path | Request / response |
| --- | --- | --- |
| `GET` | `/store/digital-downloads` | Public plugin capability metadata. |
| `GET` | `/store/digital-downloads/products/:variant_id` | `{ product: { product_id, variant_id, title?, kind, delivery_types, previews[] } }`. Sanitized; never contains protected asset locations. |
| `GET` | `/store/digital-downloads/previews/:asset_id` | Public, sanitized preview bytes. Supports normal media headers. |
| `GET` | `/store/digital-downloads/library` | Customer auth. Query: `limit`, `offset`, repeated `status`, repeated `kind`, `order_id`, `q`. Returns `{ entitlements, count, limit, offset }`. |
| `GET` | `/store/digital-downloads/entitlements/:id` | Customer auth. Returns `{ entitlement }`. Cross-owner/store access is indistinguishable from not found. |
| `POST` | `/store/digital-downloads/entitlements/:id/grants` | Customer auth. Body `{ asset_id, action: "download" | "stream" }`; returns `{ grant: { token, asset_id, expires_at, url } }`. Accepts `Idempotency-Key`. |
| `POST` | `/store/digital-downloads/guest/access` | Body `{ token, email? }`; email is required by the default matching policy. Returns `{ entitlement }`. |
| `POST` | `/store/digital-downloads/guest/grants` | Body `{ token, email?, entitlement_id, asset_id, action }`; email is required by the default matching policy. Returns the same grant envelope. Accepts `Idempotency-Key`. |
| `GET` | `/store/digital-downloads/content/:asset_id` | `Authorization: Bearer <grant-token>`. Supports a single RFC 7233 range. The bearer is never accepted in a query string. |
| `POST` | `/store/digital-downloads/licenses/:id/reveal` | Customer auth or body `{ guest_token, guest_email? }`; guest email is required by the default matching policy. Returns `{ license_key }`. |
| `POST` | `/store/digital-downloads/licenses/activate` | Body `{ license_key, instance_id, label?, metadata? }`; returns `{ license, activation }`. Accepts `Idempotency-Key`. |
| `POST` | `/store/digital-downloads/licenses/deactivate` | Body `{ license_key, instance_id, reason? }`; returns `{ license, activation }`. Accepts `Idempotency-Key`. |
| `POST` | `/store/digital-downloads/licenses/heartbeat` | Body `{ license_key, instance_id, metadata? }`; returns `{ license, activation, next_heartbeat_at? }`. Accepts `Idempotency-Key`. |
| `POST` | `/store/digital-downloads/licenses/validate` | Body `{ license_key, instance_id? }`; returns `{ valid, license, activation?, reason? }`. |

The SDK adds `action`, `method`, `headers`, and `supports_ranges` to a returned
grant locally. These fields are adapter conveniences, not additional wire
fields.
