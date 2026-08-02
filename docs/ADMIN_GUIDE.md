# Medusa Admin guide

The plugin ships supported Medusa Admin routes and detail-page widgets built
with the Admin SDK and `@medusajs/ui`. They use the authenticated Admin API
under `/admin/digital-downloads`; they do not replace or patch Medusa's built-in
Admin layout.

## Before opening Admin

Confirm that:

1. The plugin is installed and registered in the Medusa backend.
2. `npx medusa db:migrate` completed successfully.
3. API and worker processes run the same plugin version.
4. Local or S3 storage is configured at runtime.
5. The Admin user has permission to use the plugin's Admin routes.

The Admin UI never asks for or displays encryption material, token/signing
secrets, S3 secret keys, private object keys, raw download grants, guest
capabilities, or plaintext license keys.

## Navigation and overview

Open **Digital Downloads** in the Medusa sidebar. The `/digital-downloads`
overview provides:

- active digital product count;
- active entitlement count;
- download activity over the last 30 days;
- protected storage bytes;
- search by configuration/product context;
- status and delivery-type filters;
- stable 20-row pagination;
- page selection and bulk archive;
- links to create a configuration, manage licenses, and open settings.

Metrics and the list load independently, so a report failure does not silently
replace the product-list state. Loading, empty, filtered-empty, and retryable
error states are shown explicitly.

Archiving a selected configuration changes catalog availability; it does not
delete historical entitlements or their purchase snapshots.

## Configure a Medusa product

There are two entry points:

- select **Create digital product** from the Digital Downloads overview;
- select **Configure** in the **Digital delivery** widget on a Medusa product
  detail page.

The product widget appears in the `product.details.after` zone and lists current
digital configurations, associated variant count, delivery type, active
release, asset count, license-policy label, and status.

The create/edit form supports:

- one Medusa product and one or more of its variants;
- an internal configuration title and description;
- protected download, protected stream, license, or download-and-license
  delivery;
- automatic-after-payment or manual fulfillment selection;
- optional logical download limit;
- optional entitlement lifetime in days;
- an optional/required license-policy ID for license delivery;
- draft, active, and archived lifecycle values exposed by the current Admin
  contract.

Product title, variant title/SKU, price, currency, tax, sales channels,
promotions, and general publication remain managed in normal Medusa product
screens.

For license products, use **Licenses** on the overview to create a policy, then
select or enter that policy for the digital configuration.

## Configuration detail

Open a row at `/digital-downloads/:id`. The page displays:

- delivery and fulfillment policy;
- download limit and access expiry;
- associated Medusa variants;
- license-policy summary when present;
- active release, timestamps, and configuration ID;
- release and asset history;
- customer entitlements;
- guarded configuration deletion.

Use **View product** to return to the Medusa product and **Edit** to change the
mutable configuration fields.

### Create and publish a release

1. Enter a unique version, optional name, and release notes.
2. Create the draft release.
3. Select the draft in **Upload assets**.
4. Choose each file's delivery role, upload at least one file, and resolve all
   failed uploads.
5. Review filename, role, MIME type, size, storage provider, status, and checksum
   prefix.
6. Publish the release.

The publish control remains disabled while a release has no assets. New
entitlements use the newly active published release. Existing entitlement
snapshots must continue to reference the release/asset versions purchased at
their own fulfillment time.

Only draft-release assets expose a delete action in the UI. A published asset
is historical delivery state and should be replaced by a new release rather
than edited in place.

### Upload behavior

The upload panel accepts multiple files, validates the current size/MIME
settings in the browser, and uploads queued files sequentially. It shows per-file
progress, success, and retryable error state, then completes the backend upload
intent into an asset record.

Choose `download`, `stream`, `preview`, `cover`, `manual`, or `license` for each
file before transfer. `preview` and `cover` are intentionally public product
media; all other roles stay protected behind entitlement grants or licensing
flows. Do not label a full paid asset as a preview.

Browser validation is convenience only. The Admin API and storage service
independently validate filename, size, MIME syntax, checksum, provider, and
storage boundaries.

An upload intent is either a same-origin local `PUT` streamed to a protected
temporary file or a direct presigned `PUT` to the configured private S3
bucket. After transfer, the Admin calls the completion route so the backend can
verify the object and create its immutable asset record. Do not copy the intent
URL, upload token, or required headers into support tickets; treat them as
short-lived capabilities.

## Customer entitlements

The configuration detail page contains a paginated entitlement table with:

- order/customer context;
- purchased item/variant;
- logical download count and limit;
- masked license status/key hint;
- access expiry;
- entitlement status;
- reissue action for revoked/expired records.

Search by order, customer, or item, filter by status, select a page of active
records, and use **Revoke selected** for a bulk support action. The UI confirms
bulk revocation before submitting it.

The current bulk action supplies an administrator-generated reason. For
high-assurance support operations that require a case-specific reason or
external ticket reference, use the Admin API and include the explicit reason.

Revocation preserves the historical entitlement record. It should invalidate
new access grants and active sessions according to backend policy. Reissue is a
separate audited operation; do not use it to conceal an incorrect refund or
chargeback state.

## Medusa order widget

The **Digital fulfillment** widget appears in `order.details.after` only when an
order has digital entitlement data or is still loading it. It shows:

- item/variant;
- logical download usage;
- masked license fulfillment;
- expiry and entitlement state;
- revoke or reissue action.

The widget intentionally omits signed URLs, raw grants, guest tokens, storage
locations, encrypted values, and plaintext license keys.

## License management

Open `/digital-downloads/licenses` from the overview. The page provides:

- paginated license policies associated with digital product configurations;
- pooled or generated license strategy selection, plus `none` to disable
  license issuance;
- generated-key pattern, activation limit, validity, and required-device-ID
  controls;
- safe per-policy imported-key inventory with status filtering and pagination;
- pooled key import with `reject` or `skip` duplicate handling.

Import one key per line. Plaintext is sent only for the import request, cleared
from the form after the operation, encrypted/hashed by the backend, and never
redisplayed as inventory. The inventory exposes only status and a non-secret
key hint. Do not paste production keys into screenshots, browser recordings,
support tickets, or telemetry.

The v1 model attaches imported pool keys directly to a license policy. There
is no separate license-pool CRUD workspace in the shipped Admin UI.

Version 1 does not expose an external-provider strategy through the Admin/API
contract. Use pooled keys for externally generated inventory, or build and
test a separate trusted integration before extending the route validators and
fulfillment workflow.

Offline activation is also not a version 1 capability. The API accepts
`allow_offline_activation` only when omitted or `false`; no offline token or
lease-verification flow is shipped.

## Settings

Open `/digital-downloads/settings` from the overview. The shipped screen
contains two groups.

### Deployment diagnostics

- active local or S3-compatible provider;
- local upload path, or S3 bucket, region, endpoint, prefix, and path-style
  mode;
- credential/key configured indicators without credential values;
- readiness state and non-secret configuration issues;
- **Test storage** action.

Secrets remain in `medusa-config.ts`/environment or the deployment's secret
manager. These topology fields are read-only in Admin: the settings endpoint
does not provision storage, create credentials, or move existing objects.
Runtime module options are the topology boundary; deploy/restart when those
values change. See
[CONFIGURATION.md](CONFIGURATION.md).

### Fulfillment behavior

- plugin enabled state and default delivery type;
- signed grant lifetime and hard maximum grant lifetime;
- maximum upload size;
- default logical download limit;
- guest-access and order-email-match policy;
- audit retention target.

Order-email matching defaults to enabled. While enabled, guest access, guest
grant, and guest license-reveal requests must include the email from the order;
missing and mismatched values are rejected without revealing which credential
was wrong. Storefront recovery pages should prompt for that email rather than
including it in the link.

The MIME allowlist, streaming capability, storage topology, and any default
expiry policy shown as runtime context are not editable database settings.
Change the corresponding typed module options and deploy the backend.

These defaults apply to new configuration/entitlement decisions. Updating a
default must not rewrite an existing purchase snapshot.

Audit retention currently records an operational policy value; the v1 jobs do
not automatically purge durable download/license audit records at that age.
Use a separately reviewed export/purge process when a compliance requirement
demands physical deletion.

The health operation returns structured `ready`, `provider`, `issues`, and
`operation` data; the Admin translates readiness into a success/error toast
and surfaces safe issue codes. The optional API round-trip operation also
reports `ok` and latency after write/read/delete. A passing test is not a
substitute for an end-to-end upload, publish, purchase, range, and delete test
through the production network.

## Delete and archive behavior

- **Archive** removes a configuration from active use while preserving it.
- **Delete configuration** requires browser confirmation and is subject to
  backend retention checks.
- Deleting a configuration must never silently erase customer order history.
- Removing a draft asset is not proof that its physical object was immediately
  erased; storage cleanup follows backend reference/retention policy.
- Published release history should be retired/superseded, not rewritten.

Always prefer archive when customer ownership or audit context may exist.

## Shipped Admin boundaries

The current v1 Admin bundle includes the overview, create/detail/edit/settings
and licenses routes plus product and order widgets described above. The
following backend capabilities do not currently have dedicated Admin pages:

- individual activation/device history;
- complete download/license audit browsing and export;
- fulfillment-operation, notification-delivery, and reconciliation queues;
- manual entitlement issuance;
- email-template editing or resend queues.

Use documented Admin API routes or operational tooling for implemented backend
capabilities. Items in [V1_PLAN.md](V1_PLAN.md) remain roadmap work until code,
tests, and an Admin surface ship.

## Troubleshooting

### Digital Downloads is absent from the sidebar

- Confirm the package is registered as a plugin and the Admin was rebuilt.
- Confirm the installed tarball contains its Admin export.
- Confirm the host Medusa/Admin versions satisfy peer requirements.
- Clear stale Admin build output only through the host's normal build process.

### A page returns “not configured” or capability unavailable

- Run migrations and restart the API/worker processes.
- Confirm the `digitalDownloads` module service resolves.
- Compare the installed package version in the backend and Admin bundle.
- A `capability_not_available` response is not an expected v1 steady state. It
  indicates mismatched route/module artifacts or an incomplete deployment; do
  not treat it as a successful empty result.

### Upload fails

- Check both the Admin setting and hard module/API upload ceiling.
- Check MIME allowlist, browser-reported MIME, checksum, and filename.
- For local storage, check directory ownership and shared mounts.
- For S3, check endpoint/region/path style/session token and prefix permission.
- Check reverse-proxy request limits and timeouts.

### Product or order widget shows no rows

- Confirm the product variants are linked to a digital configuration.
- Confirm the configuration has a published release.
- Confirm fulfillment has produced an entitlement for the order.
- Use the overview or API with the same product/order filter to distinguish an
  empty result from a widget request failure.

### Revoke/reissue fails

Inspect the safe error code and request ID, then check current entitlement
state, refund policy, active workflow lease, and module capability. Never work
around a conflict by editing database rows or replaying all order events.

The overview and settings footer include the safe attribution link:
[Brought to you by MakePay.io — crypto payment gateway.](https://makepay.io)
