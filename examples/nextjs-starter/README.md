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
4. Add `digital-library.tsx.example` to the account page and
   `digital-product-previews.tsx.example` to the product detail template.
5. Optionally use `guest-digital-library.tsx.example` for guest magic links.

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
