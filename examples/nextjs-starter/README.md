# Official Medusa Next.js starter integration

These copy-ready examples target the official App Router starter and its
standard `_medusa_jwt`, `sdk`, and `getAuthHeaders` helpers. Files use the
`.example` suffix so installing this plugin does not compile a second Next.js
application. Copy them into the corresponding starter paths and remove the
suffix.

1. Add `digital-downloads-provider.tsx.example` near the account layout and
   wrap the product/account subtree in the provider. Pass a stable, non-secret
   customer/session `identityKey`; change it on sign-in, sign-out, or account
   switch. Pass the same value to the account-library component.
2. Copy the catch-all BFF route. It forwards only the plugin Store API, adds the
   HttpOnly customer JWT server-side, streams protected ranges, and never
   forwards Medusa cookies to the backend.
3. Copy `grant-cookie/route.ts.example`. It moves a short-lived content grant
   from JavaScript memory into a path-scoped HttpOnly cookie, enabling native
   browser download and byte-range streaming without a token in the media URL.
4. Add `digital-library.tsx.example` to the account downloads page,
   `order-digital-downloads.tsx.example` to the customer order-detail page, and
   `digital-product-previews.tsx.example` to the product detail template.
5. Optionally use `guest-digital-library.tsx.example` on a dedicated guest
   recovery page for links delivered through the Notification Module.

Set the server-only `MEDUSA_BACKEND_URL`, the normal
`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`, and the storefront's absolute
`NEXT_PUBLIC_BASE_URL` (for example, `https://shop.example`). The provider uses
that configured origin during SSR and in the browser; it never reads `window`
during render. Do not expose the Medusa customer JWT, guest token, or content
grant in public environment variables, query strings, analytics, React Server
Component payloads, or persistent browser storage.

Suggested guest links use a fragment, which browsers do not send to the
server:

```text
https://shop.example/us/digital-access#token=<opaque-guest-token>
```

The guest example removes the fragment immediately and holds the token only in
component memory. It then prompts for the order email and sends that email in
guest requests; `require_order_email_match` is enabled by default. Do not add
the email to the link. Protected responses remain streamed through the BFF;
the plugin commits grant/download consumption before the first response byte
and does not buffer the response body.

## Account and order-history pages

Copy the account component to
`src/modules/account/components/digital-library.tsx` and mount it on the
starter's existing account dashboard or on a new `/account/downloads` page.
Keep that route inside `StorefrontDigitalDownloadsProvider` and pass the same
non-secret `identityKey` to both. The key must change when the signed-in
customer/session changes.

Copy the order component to
`src/modules/order/components/order-digital-downloads.tsx`. In the official
starter's existing customer order-details page (currently the
`/account/orders/details/[id]` route), render it beside the native order line
items without replacing the order page:

```tsx
<OrderDigitalDownloads
  identityKey={customerIdentityKey}
  order={{ id: order.id, display_id: order.display_id }}
/>
```

The component forces every library request to `order.id`; additional filters
cannot change that scope. Supplying `order.display_id` keeps the buyer-facing
order number in the heading and entitlement cards while authorization remains
bound to Medusa's internal order and customer IDs.

For guest delivery, create a page such as `/digital-access`, mount
`GuestDigitalLibrary`, and configure the trusted `digital-downloads-delivery`
email template to link to:

```text
https://shop.example/us/digital-access#token=<opaque-guest-token>
```

The route must remain dynamic and must not read or serialize the fragment on
the server. The supplied guest component removes it immediately, asks for the
order email, and exchanges both values through POST requests.
