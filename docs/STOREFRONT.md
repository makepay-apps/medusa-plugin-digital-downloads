# Storefront integration

The package ships a framework-neutral typed client and style-light React
primitives. They extend a normal Medusa storefront; they do not replace product
listing, carts, checkout, payment, order creation, or customer authentication.

The matching Store API routes are documented in [API.md](API.md). Copy-ready
App Router examples for the official Medusa Next.js starter are included under
`examples/nextjs-starter` in the package.

## Install and import

Install the exact plugin version in the storefront when you want its client or
React exports. Use npm after registry publication is verified:

```bash
npm install @makecrypto/medusa-plugin-digital-downloads@0.3.0
```

Or use the matching deterministic GitHub release artifact:

```bash
npm install https://github.com/makepay-apps/medusa-plugin-digital-downloads/releases/download/v0.3.0/makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz
```

Import from the dedicated storefront export:

```ts
import {
  createDigitalDownloadsFetchClient,
  fetchDigitalAccessGrant,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"
```

The client API is framework-neutral, but the version 1 `storefront` entry also
re-exports the React provider, hooks, and components. Consequently `react` and
`react-dom` are required peer dependencies even when an integration uses only
the Fetch client.

## Native Fetch client

The convenience constructor accepts a Medusa backend URL, optional publishable
API key, optional customer bearer token, default headers, credential policy,
and request timeout:

```ts
import {
  createDigitalDownloadsFetchClient,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

export const digitalDownloads = createDigitalDownloadsFetchClient({
  baseUrl: process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL!,
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  authToken: async () => getCurrentCustomerToken(),
  credentials: "include",
  timeoutMs: 15_000,
})
```

`authToken` may be a string or an async function and is resolved for every
request. The transport sends it as `Authorization: Bearer ...`.
`publishableKey` is sent as `x-publishable-api-key`. Set `credentials:
"include"` only when the storefront and backend cookie/CORS policy is
configured for credentialed requests.

The equivalent low-level construction is:

```ts
import {
  createDigitalDownloadsClient,
  createFetchTransport,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

const client = createDigitalDownloadsClient({
  transport: createFetchTransport({
    baseUrl: process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL!,
    publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  }),
})
```

## Existing Medusa JavaScript SDK

The adapter consumes the structural `sdk.client` interface and does not add a
dependency on one exact `@medusajs/js-sdk` version:

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

The default route prefix is `/store/digital-downloads`. `pathPrefix` may be
overridden for a deliberately remounted or proxied API, but the frontend and
backend must agree.

## Customer and guest access

Authenticated customers use the host application's normal Medusa customer
session or bearer token:

```ts
const library = await digitalDownloads.listLibrary({
  limit: 20,
  offset: 0,
})
```

Guest access uses a separate opaque purchase capability. The SDK sends it only
inside a POST JSON body—never in a query string or header:

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

The `email` field is optional in the type because a merchant can deliberately
disable order-email matching. The persisted `require_order_email_match` setting
defaults to `true`, so normal guest flows must prompt for the order email and
send it on both access exchange and grant creation. Missing and mismatched
values intentionally look like an invalid capability. Do not add the email to
the magic link.

Keep guest capabilities in memory or an encrypted/HttpOnly server session. A
guest magic link can place the capability in the URL fragment. Capture it in
memory and remove the fragment immediately with `history.replaceState`, then
prompt for the order email and exchange the pair; fragments are not sent to the
origin server. Do not place capabilities in query strings, analytics, React
Server Component payloads, logs, screenshots, or persistent browser storage.

Sensitive client calls use `cache: "no-store"`. The backend independently
returns private/no-store response headers.

## Client methods

The shipped client exposes:

| Method | Purpose |
| --- | --- |
| `getProductPreview(variantId, options?)` | Fetch safe public preview metadata for one Medusa variant. |
| `listLibrary(query?, options?)` | Fetch a paginated authenticated-customer library. |
| `getEntitlement(entitlementId, options?)` | Fetch one customer-owned entitlement. |
| `getGuestAccess({ token, email? }, options?)` | Exchange a guest purchase capability and, by default, its matching order email for a safe entitlement projection. |
| `requestAccessGrant(entitlementId, input, options?)` | Request a customer-owned download or stream grant. |
| `requestGuestAccessGrant({ token, email?, entitlement_id, asset_id, action }, options?)` | Request a grant using guest capability and default order-email proof in the request body. |
| `requestDownloadGrant(entitlementId, assetId, options?)` | Customer download convenience wrapper. |
| `requestStreamGrant(entitlementId, assetId, options?)` | Customer stream convenience wrapper. |
| `revealLicense(licenseId, { guest_token?, guest_email?, reason? }, options?)` | Reveal recoverable license material; guest callers include the default order-email proof. |
| `activateLicense(input, options?)` | Register a software instance using a license key. |
| `deactivateLicense(input, options?)` | Deactivate a software instance. |
| `heartbeatLicense(input, options?)` | Refresh an active software instance. |
| `validateLicense(input, options?)` | Validate a license and, optionally, an instance. |

Library filters include `limit`, `offset`, `order_id`, `status`, `kind`, and
`q`. Mutation request options may include `idempotency_key`, sent as the
`Idempotency-Key` header.

## Consume a protected-content grant

The grant response contains a short-lived token, but the SDK does not put it in
the URL. It normalizes the grant with an Authorization header and provides a
safe Fetch helper:

```ts
import {
  fetchDigitalAccessGrant,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

const { grant } = await digitalDownloads.requestDownloadGrant(
  entitlementId,
  assetId,
  { idempotency_key: crypto.randomUUID() }
)

const response = await fetchDigitalAccessGrant(grant)
if (!response.body) throw new Error("Protected content response has no body")

// Pipe response.body in a BFF/worker or supply a bounded browser consumer.
```

For a byte range:

```ts
const response = await fetchDigitalAccessGrant(grant, {
  range: "bytes=0-1048575",
})
```

A first redemption commits one logical download before the backend writes
response headers or the first body byte. It then opens a bounded 15-minute
continuation window on that same grant, subject to its original expiry. Reuse
the grant only for subsequent range requests during that window. A full
non-range retry is not a continuation. Once consumption has committed, a
disconnect or late transfer failure remains counted and is recorded as a failed
transfer; failures before commit expose no content and do not consume access.

The same-origin backend route proxies both local and S3 objects with
backpressure; it buffers no response body, and `response.body` remains a stream
that the caller owns. The supplied React `DigitalLibrary` convenience opener
does create a browser `Blob`, but it enforces a hard 64 MiB byte ceiling even
when `Content-Length` is absent or dishonest. It validates declared/observed
lengths and MIME types, rejects content encoding, opens only a narrow audio/video
MIME allowlist inline, and forces downloads to `application/octet-stream`.
Large files and seekable audio/video should use the included same-origin BFF
plus path-scoped HttpOnly grant-cookie pattern. That permits native browser
range requests without exposing the bearer in a media URL or
JavaScript-readable cookie.

Do not navigate directly to `grant.url`: the content route requires the grant's
Authorization header.

## React provider and hooks

Wrap the relevant client-side tree once:

```tsx
"use client"

import {
  DigitalDownloadsProvider,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"
import { digitalDownloads } from "@/lib/digital-downloads"

export function DigitalDownloadsRoot({
  children,
  identityKey,
}: {
  children: React.ReactNode
  identityKey?: string
}) {
  return (
    <DigitalDownloadsProvider
      client={digitalDownloads}
      identityKey={identityKey}
    >
      {children}
    </DigitalDownloadsProvider>
  )
}
```

Customer resource hooks/components require a non-secret `identityKey`, supplied
on the provider or directly to the hook/component. Use a stable customer/session
identifier that changes on sign-in, sign-out, and account/session switch; never
use a JWT, guest token, license key, or other credential. Changing the key
immediately scopes away data loaded for the previous customer. Preview-only and
guest-only trees may omit it because guest hooks derive identity from their
explicit capability and email.

Available hooks are:

- `useDigitalDownloadsClient`
- `useDigitalProductPreview`
- `useDigitalLibrary`
- `useDigitalEntitlement`
- `useDigitalEntitlementActions`
- `useDigitalLicense`, an alias focused on license-management UIs

Resource hooks expose normalized data, `isLoading`, `isRefreshing`, `error`,
and `refetch`. Action hooks expose `pendingAction`, normalized errors, and the
grant/license mutations. Passing
`access={{ guest_token, guest_email: orderEmail }}` makes the library,
entitlement, grant, and reveal hooks use the explicit guest POST flows and
forwards the email required by the default matching policy.

## React components

`DigitalProductPreviews` renders explicitly public image, audio, video, or
generic preview metadata:

```tsx
import {
  DigitalProductPreviews,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

<DigitalProductPreviews
  heading="Listen, watch, or read a sample"
  variantId={selectedVariant.id}
/>
```

`DigitalLibrary` renders a buyer library and defaults to
`DigitalEntitlementCard` for each item:

```tsx
import {
  DigitalLibrary,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

<DigitalLibrary
  heading="Downloads & licenses"
  identityKey={customerIdentityKey}
  query={{ limit: 20 }}
  onGrant={openProtectedContentThroughBff}
/>
```

The components use semantic headings, lists, native controls, live status/error
regions, loading and empty states, and minimal markup. Use `className`, render
callbacks, custom messages, and event callbacks to apply a storefront design.
They intentionally do not ship a complete store theme or checkout.

The supplied `DigitalProductPreviews` and `DigitalLibrary` display a small
fixed attribution by default:
[Brought to you by MakePay.io — crypto payment gateway.](https://makepay.io)
`showAttribution={false}` hides it where commercial policy permits, or render
`MakePayAttribution` explicitly elsewhere. The component's destination is
fixed to the safe HTTPS MakePay homepage.

## Next.js starter examples

Copy files from `examples/nextjs-starter` into the corresponding official
Medusa starter paths and remove the `.example` suffix. The example set includes:

- a configured provider;
- a Store API/data helper;
- a constrained catch-all BFF route;
- a same-origin grant-to-HttpOnly-cookie exchange;
- account and guest libraries;
- product preview integration.

Set server-only `MEDUSA_BACKEND_URL` and the normal
`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`. Review the BFF allowlist, origin check,
cookie security, route prefix, and response-header forwarding for your domains
before production use. Pass a changing non-secret customer `identityKey` to the
provider/account library, and prompt guest buyers for their order email; keep
both the capability and email out of the recovery-link URL.

## Error handling

Client errors normalize to `DigitalDownloadsError`:

```ts
import {
  normalizeDigitalDownloadsError,
} from "@makecrypto/medusa-plugin-digital-downloads/storefront"

try {
  await digitalDownloads.getEntitlement(entitlementId)
} catch (error) {
  const failure = normalizeDigitalDownloadsError(error)
  console.error(failure.code, failure.status, failure.requestId)
}
```

The error can include `status`, `code`, `requestId`, `retryAfter`, and safe
details. Never serialize the complete underlying error into storefront HTML or
telemetry; SDK/network errors can contain request configuration.

## Checkout and MakePay interoperability

Digital Downloads does not replace Medusa cart completion or payment sessions.
Use any Medusa payment provider normally. With the separate MakePay provider:

1. Configure `@makecrypto/medusa-plugin-makepay` under Medusa's Payment Module.
2. Complete the normal Medusa cart/payment-session flow.
3. Redirect the buyer to the provider's `paymentSession.data.next_action.url`.
4. Let MakePay's signed webhook update the Medusa payment state.
5. Let Digital Downloads react to the normal Medusa lifecycle; never create an
   entitlement directly from storefront code.

No MakePay credential belongs in this plugin or storefront. MakePay remains an
optional, independent payment provider.

## Production checklist

- Allow the storefront origin in Medusa's Store CORS configuration.
- Supply the correct publishable key and customer-auth strategy.
- Keep guest capabilities and content grants out of URLs, logs, analytics,
  caches, persistent storage, error trackers, and server-rendered payloads.
- Render only explicitly public preview URLs as product media.
- Never turn storage keys or persisted asset records into client URLs.
- Handle expired, revoked, refunded, suspended, and limit-reached states.
- Use a BFF/streaming response rather than relying on the built-in 64 MiB
  browser reader for large content.
- Give buyers a support path that does not ask them to email secret URLs or raw
  license keys.
- Test byte ranges, no-store headers, proxy buffering, CDN behavior, and grant
  expiry through the production network path.
