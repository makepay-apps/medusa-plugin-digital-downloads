# SMTP notification provider example

This example turns the plugin's logical notification templates into complete,
escaped email content and sends it through an existing SMTP service. It is a
host-application example: copy it into the Medusa application's `src/modules`
directory, remove the `.example` suffixes, and review the copy and URLs for the
storefront.

Install the transport dependency in the Medusa backend:

```bash
npm install nodemailer
npm install --save-dev @types/nodemailer
```

Medusa permits only one provider for a notification channel. If the store
already has an email provider, do **not** register this example beside it.
Copy `templates.ts.example` into that provider and dispatch templates whose ID
starts with `digital-downloads-` through `renderDigitalDownloadEmail`; keep the
provider's existing branch for order, authentication, and other host emails.
If this standalone provider becomes the store's sole email provider, extend
its `send` method to render every non-digital host template before production.
Its deliberate unsupported-template error prevents silently sending the wrong
content.

For a new store where this will be the sole email provider, register the copied
provider under Medusa's Notification Module:

```ts
import { defineConfig, Modules } from "@medusajs/framework/utils"

export default defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/notification",
      options: {
        providers: [
          {
            resolve: "./src/modules/digital-download-email",
            id: "digital-download-email",
            options: {
              channels: ["email"],
              smtpUrl: process.env.SMTP_URL!,
              from: process.env.DIGITAL_DOWNLOADS_EMAIL_FROM!,
              storefrontBaseUrl: process.env.STOREFRONT_URL!,
              accountLibraryPath: "/account/downloads",
              orderDetailsPathTemplate: "/account/orders/details/{order_id}",
              guestAccessPath: "/digital-access",
            },
          },
        ],
      },
    },
  ],
})
```

The renderer recognizes these plugin template identifiers:

- `digital-downloads-delivery`
- `digital-downloads-revoked`
- `digital-downloads-reissued`
- `digital-downloads-expired`

Registered-customer delivery and reissue messages link directly to Medusa's
native order-details page when the notification includes `order_id`. The
renderer percent-encodes the ID before replacing the single required
`{order_id}` placeholder. Notifications without an order ID fall back to
`accountLibraryPath`. At provider startup, the exported
`validateDigitalDownloadEmailOptions` self-check rejects non-HTTPS base URLs,
credentials in the base URL or resolved path, cross-origin paths, and malformed
order path templates; call it directly from configuration tests if desired.

Guest delivery and reissue messages always use `guestAccessPath`, even when an
order ID is present. Their bounded-lifetime purchase capability is placed only
in the URL fragment, never in a query parameter or path. The fragment is not
sent to the storefront server, but the email provider and delivered message still
handle secret material. Do not log the notification object, rendered content,
SMTP URL, or transport response.
Do not use Medusa's logging-only local notification provider for guest delivery:
it serializes notification data, which would put the transient capability in
application logs.

The storefront guest page must capture and remove the fragment immediately,
prompt for the order email, and exchange both values through the plugin's guest
Store API. Registered customers without an order ID receive the configured
account-library fallback and reveal license values only after authenticating
and explicitly requesting them.
