# HTTP API reference

Digital Downloads adds Admin and Store API routes beneath a single version-1
namespace:

- `/admin/digital-downloads` for authenticated Medusa Admin users;
- `/store/digital-downloads` for storefront discovery, customer libraries,
  guest access, protected content, and license clients.

JSON fields use `snake_case`. Timestamps are ISO 8601 strings. Identifiers are
opaque; clients must not derive product, storage, or ownership information from
their shape. Unknown fields in mutation bodies are rejected unless a route
explicitly documents otherwise.

The typed client described in [STOREFRONT.md](STOREFRONT.md) is the recommended
way to call the Store API. This document is the wire-level contract for custom
clients and Admin integrations. A machine-readable OpenAPI 3.1 contract ships
at [`openapi/openapi.yaml`](../openapi/openapi.yaml).

## Authentication and capabilities

| Route class | Credential |
| --- | --- |
| Admin | A normal authenticated Medusa Admin user. The plugin's Admin RBAC middleware must also allow the operation. |
| Public Store metadata and previews | No customer credential. Send the host's normal `x-publishable-api-key` when its Store API policy requires one. |
| Customer library and entitlement | The host's normal authenticated customer bearer/session. |
| Guest purchase access | An opaque guest capability and, by default, the order email in a POST JSON body. |
| Protected content | A short-lived grant in `Authorization: Bearer <grant-token>`. |
| License reveal | An owning customer credential, or `guest_token` plus, by default, `guest_email` in the POST body. |
| License activation lifecycle | The license key and instance data in the POST body; the routes are rate-limited. |

Customer authentication, guest capabilities, and content grants are distinct.
A customer bearer cannot be substituted for an asset grant on the content
route. A guest token is never accepted as a query parameter, cookie name, or
Authorization bearer by the plugin's guest endpoints.

Never put a guest token, grant token, or license key in a URL. URLs are commonly
captured by browsers, proxies, access logs, analytics, and referrer headers.

## Common request behavior

### Pagination and filters

Collection routes use offset pagination:

```text
?limit=20&offset=0
```

The default limit is `20`; the maximum is `100`. Responses include the
collection, `count`, `limit`, and `offset`. Supported routes also accept `q`,
`order`, and the filters listed below. Do not assume undocumented filters are
stable.

### Idempotency

Mutation routes marked **idempotent** accept:

```http
Idempotency-Key: checkout-or-action-specific-key
```

Keys must contain 8–255 characters and match
`[A-Za-z0-9][A-Za-z0-9._:-]*`. Reuse a key only for a retry of the same logical
operation and payload. Use a new key for a new activation, grant, or fulfillment
attempt.

The following Store mutations accept the header:

- customer entitlement grant creation;
- guest grant creation;
- license activation, deactivation, and heartbeat.

Admin order issuance is itself protected by durable order/line-item
idempotency in the fulfillment domain. Clients still must not blindly replay
every order when investigating a failed job.

### Cache and secret handling

Private entitlement, grant, guest, license, Admin settings, and protected
content responses use `Cache-Control: private, no-store`. Grant and license
responses must never be stored in shared caches or application logs. Public
preview bytes can use short revalidation caching.

Store projections omit storage paths, object keys, provider credentials, token
hashes, encrypted license material, and internal audit data. Admin projections
also strip credentials and secret values. Possession of an Admin response is
not a substitute for authorizing an object download.

### Error envelope

JSON failures use a stable safe envelope:

```json
{
  "type": "invalid_request",
  "code": "invalid_request",
  "message": "The request could not be completed.",
  "details": {},
  "request_id": "req_01..."
}
```

`details` and `request_id` are optional. Server-side failures do not echo raw
exception messages. Typical status codes are:

| Status | Meaning |
| --- | --- |
| `400` | Invalid syntax, body, query, range, or idempotency key. |
| `401` | Required Admin, customer, guest, or content capability is absent/invalid. |
| `403` | The authenticated principal is not allowed to perform the operation. |
| `404` | The resource is absent or deliberately hidden from a non-owner. |
| `409` | A uniqueness, state-transition, lease, or idempotency conflict. |
| `416` | The requested content byte range is unsatisfiable. |
| `422` | A syntactically valid request violates a domain rule. |
| `429` | A public/secret-bearing endpoint exceeded its rate limit. |
| `413` | An upload or JSON body exceeds the route/configured ceiling. |
| `503` | The module is not installed, configured, migrated, or resolvable. |

Use the response `request_id` for support correlation. Do not attach bearer
tokens, raw license keys, or complete secret-bearing request bodies to a ticket.

## Store API

### Route summary

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/store/digital-downloads` | Public | Plugin version and capability metadata. |
| `GET` | `/store/digital-downloads/products/:variant_id` | Public | Safe digital-delivery and preview metadata for one Medusa variant. |
| `GET` | `/store/digital-downloads/previews/:asset_id` | Public | Bytes for an explicitly public preview asset. |
| `GET` | `/store/digital-downloads/library` | Customer | Paginated ownership library. |
| `GET` | `/store/digital-downloads/entitlements/:id` | Customer owner | One safe entitlement. |
| `POST` | `/store/digital-downloads/entitlements/:id/grants` | Customer owner | Create a short-lived content grant. **Idempotent.** |
| `POST` | `/store/digital-downloads/guest/access` | Guest body token + default order-email proof | Exchange a guest capability for a safe entitlement. Rate-limited. |
| `POST` | `/store/digital-downloads/guest/grants` | Guest body token + default order-email proof | Create a short-lived content grant. Rate-limited and **idempotent**. |
| `GET` | `/store/digital-downloads/content/:asset_id` | Grant bearer | Transfer protected bytes; supports one range. |
| `POST` | `/store/digital-downloads/licenses/:id/reveal` | Customer owner or guest body token + default order-email proof | Reveal recoverable license material. |
| `POST` | `/store/digital-downloads/licenses/activate` | License key | Activate an instance. Rate-limited and **idempotent**. |
| `POST` | `/store/digital-downloads/licenses/deactivate` | License key | Deactivate an instance. Rate-limited and **idempotent**. |
| `POST` | `/store/digital-downloads/licenses/heartbeat` | License key | Refresh an activation lease. Rate-limited and **idempotent**. |
| `POST` | `/store/digital-downloads/licenses/validate` | License key | Validate a key and optional instance. Rate-limited. |

### Metadata and product previews

`GET /store/digital-downloads` returns public plugin metadata and supported
capabilities. It contains no runtime credentials or merchant-private settings.

`GET /store/digital-downloads/products/:variant_id` returns:

```json
{
  "product": {
    "product_id": "prod_01...",
    "variant_id": "variant_01...",
    "title": "Album download",
    "kind": "audio",
    "delivery_types": ["download", "stream"],
    "previews": [
      {
        "id": "dasset_01...",
        "title": "30 second sample",
        "mime_type": "audio/mpeg",
        "url": "/store/digital-downloads/previews/dasset_01..."
      }
    ]
  }
}
```

Only assets explicitly assigned the `preview` or `cover` role can appear here.
A protected master asset does not become public because a caller knows its ID.

`GET /store/digital-downloads/previews/:asset_id` returns bytes rather than a
JSON envelope. It supports standard media response headers and a single byte
range. Non-preview, retired, or unavailable assets return not found.

### Customer library

`GET /store/digital-downloads/library` accepts `limit`, `offset`, `q`,
`order_id`, `status`, and `kind`. It returns:

```json
{
  "entitlements": [
    {
      "id": "dent_01...",
      "status": "active",
      "order_id": "order_01...",
      "line_item_id": "item_01...",
      "unit_index": 0,
      "created_at": "2026-07-31T09:59:00.000Z",
      "granted_at": "2026-07-31T10:00:00.000Z",
      "expires_at": null,
      "product": {
        "product_id": "prod_01...",
        "variant_id": "variant_01...",
        "title": "Album download",
        "kind": "audio"
      },
      "assets": [
        {
          "id": "dasset_01...",
          "title": "Lossless album",
          "filename": "album.flac",
          "kind": "audio",
          "mime_type": "audio/flac",
          "size_bytes": 123456789,
          "delivery_types": ["download", "stream"],
          "download_count": 0,
          "download_limit": 5
        }
      ],
      "capabilities": {
        "can_download": true,
        "can_stream": true,
        "can_reveal_license": false,
        "can_activate_license": false,
        "can_deactivate_license": false
      }
    }
  ],
  "count": 1,
  "limit": 20,
  "offset": 0
}
```

`GET /store/digital-downloads/entitlements/:id` returns `{ "entitlement":
... }`. Looking up another customer's entitlement returns the same not-found
shape as an unknown ID.

Entitlement responses are safe projections, not persistence records. Clients
should tolerate additive fields and render the nested `product`, `assets`,
optional singular `license`, and `capabilities` fields rather than inferring
access from dates alone.

### Customer content grants

Create a download or stream grant:

```http
POST /store/digital-downloads/entitlements/dent_01.../grants
Authorization: Bearer <customer-access-token>
Content-Type: application/json
Idempotency-Key: grant-dent_01-dasset_01-1

{
  "asset_id": "dasset_01...",
  "action": "download"
}
```

Successful response:

```json
{
  "grant": {
    "token": "opaque-short-lived-capability",
    "asset_id": "dasset_01...",
    "expires_at": "2026-07-31T10:15:00.000Z",
    "url": "/store/digital-downloads/content/dasset_01..."
  }
}
```

The server verifies the entitlement owner, status, release snapshot, asset
membership, expiry, download allowance, requested action, and current
revocation state. The response URL is not secret by itself; the bearer token
authorizes the transfer.

Fetch the bytes without adding the token to the URL:

```http
GET /store/digital-downloads/content/dasset_01...
Authorization: Bearer opaque-short-lived-capability
Range: bytes=0-1048575
```

The route accepts either no `Range` or one `bytes=` range and returns `200` or
`206` with `Accept-Ranges`, `Content-Length`, and, for partial responses,
`Content-Range`. Multiple ranges are rejected. The response is `private,
no-store` and includes defensive content headers. Before it sets response
headers or writes the first body byte, the delivery pipeline atomically commits
one grant use and one logical entitlement download. An accounting failure
therefore returns an error without exposing protected bytes. After the commit,
the source is piped directly to the response with backpressure and no response
body is buffered. A disconnect or late source failure remains consumed and is
recorded as a failed transfer with the observed byte count. If the first
transfer is ranged, the same grant can serve additional range requests for up
to 15 minutes (and never beyond the grant's own expiry) without incrementing
the counters again; a non-range retry is not a continuation. Concurrent first
redemptions cannot both commit the same grant.

Both local-file and S3 delivery use this same-origin protected proxy; S3
presigned URLs are upload-only. The opened body is a Node `Readable` piped to
the response with backpressure, not a whole-object buffer. Local reads keep the
validated no-follow file handle open; S3 reads validate the provider's length
and range metadata and sanitize late stream errors. The route has no `HEAD`
operation in version 1.

### Guest access

Exchange a guest capability:

```http
POST /store/digital-downloads/guest/access
Content-Type: application/json

{
  "token": "opaque-guest-purchase-capability",
  "email": "buyer@example.com"
}
```

The response is `{ "entitlement": ... }`. To request protected content:

```http
POST /store/digital-downloads/guest/grants
Content-Type: application/json
Idempotency-Key: guest-grant-dent_01-dasset_01-1

{
  "token": "opaque-guest-purchase-capability",
  "email": "buyer@example.com",
  "entitlement_id": "dent_01...",
  "asset_id": "dasset_01...",
  "action": "download"
}
```

The grant response and content transfer are identical to the customer flow.
`email` is optional in the wire schema only so a merchant can deliberately
disable email matching. `require_order_email_match` defaults to `true`; under
that default, every guest access/grant request must include the order email and
a missing or mismatched value receives the same unauthorized response as an
invalid capability. Prompt the buyer for the email—do not embed it in the magic
link. Keep the guest capability in memory or in an encrypted, HttpOnly
server-side session. The plugin rejects content grant tokens supplied in query
strings.

### License lifecycle

Reveal a license owned by the authenticated customer:

```http
POST /store/digital-downloads/licenses/lic_01.../reveal
Authorization: Bearer <customer-access-token>
Content-Type: application/json

{}
```

For a guest purchase, omit customer authentication and send:

```json
{
  "guest_token": "opaque-guest-purchase-capability",
  "guest_email": "buyer@example.com"
}
```

When the default order-email matching policy is enabled, a guest reveal must
include `guest_email` and it must match the entitlement's order email. Either
request may also include an optional, bounded `reason` for a merchant-defined
audit policy. The response is only
`{ "license_key": "..." }` and is always `private, no-store`.

Activation requests use this shape:

```json
{
  "license_key": "XXXXX-XXXXX-XXXXX",
  "instance_id": "stable-installation-id",
  "label": "Workstation",
  "metadata": {
    "app_version": "1.0.0",
    "platform": "darwin"
  }
}
```

Deactivation uses `license_key` and `instance_id`. Heartbeat adds optional
bounded scalar `metadata`. Validation accepts `license_key` and an optional
`instance_id`. Lifecycle responses contain a masked license projection and,
where relevant, activation state and `next_heartbeat_at`; only reveal returns
the plaintext recoverable key.

Use an installation identifier generated by the licensed application. Do not
send invasive hardware fingerprints or personal data as the instance ID.

## Admin API

All routes in this section require a normal Medusa Admin session, bearer, or
Admin API key and pass through Medusa's policy middleware. Settings operations
use `store` read/update policy resources; catalog, upload, and license
operations use `product` read/create/update resources; entitlement, download,
audit, report, and order-issue operations use `order` read/update resources.
Collection responses use the pagination contract above. Mutation responses
return the affected safe Admin projection unless the table says otherwise.

### Settings and reports

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/admin/digital-downloads/settings` | `{ settings }`; secrets and storage topology are omitted. |
| `PATCH` | `/admin/digital-downloads/settings` | Partial non-secret settings; returns `{ settings }`. |
| `POST` | `/admin/digital-downloads/settings/test-storage` | `{ operation: "health" | "write_read_delete" }`; returns `{ storage_test }`. |
| `GET` | `/admin/digital-downloads/reports/summary` | Optional `from`, `to`, `product_config_id`; returns `{ report }`. |

`GET` combines persisted merchant settings with read-only runtime diagnostics.
Storage is represented only as `{ storage: { provider, configured } }`, plus
the MIME allowlist, streaming capability, and readiness issues. Local paths and
base URLs, S3 bucket/region/endpoint/prefix/path-style details, and credentials
are never returned.

`PATCH` accepts only persisted behavioral settings: `enabled`,
`default_delivery_type`, `default_download_limit`,
`default_grant_ttl_seconds`, `max_grant_ttl_seconds`,
`max_upload_size_bytes`, `allow_guest_access`,
`require_order_email_match`, `event_retention_days`, and `metadata`. The stable
Admin aliases `download_limit_default`, `grant_ttl_seconds`,
`signed_url_ttl_seconds`, `max_upload_bytes`, `max_upload_size_mb`, and
`audit_retention_days` normalize to those canonical fields. Storage topology,
credentials, secrets, MIME policy, and streaming support are runtime module
options and cannot be changed by this endpoint. See
[CONFIGURATION.md](CONFIGURATION.md).

`require_order_email_match` defaults to `true`. When enabled, guest access,
guest grant, and guest license-reveal requests must include the order email;
missing and mismatched values fail with the same unauthorized envelope as an
invalid guest capability.

The storage health operation returns `ready`, `provider`, `issues`, and
`operation` inside `storage_test`. `write_read_delete` additionally returns
`ok` and `latency_ms` after a private round trip; the probe deletes its test
object in a `finally` cleanup.

### Digital product configurations

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/admin/digital-downloads/product-configs` | Filters: `product_id`, `variant_id`, `status`, `delivery_type`, pagination. Returns `{ product_configs, count, limit, offset }`. |
| `POST` | `/admin/digital-downloads/product-configs` | Create a configuration; returns `201 { product_config }`. |
| `GET` | `/admin/digital-downloads/product-configs/:id` | `{ product_config }` including safe release/policy relations. |
| `PATCH` | `/admin/digital-downloads/product-configs/:id` | Partial mutable fields; returns `{ product_config }`. |
| `DELETE` | `/admin/digital-downloads/product-configs/:id` | `{ id, object: "digital_product_config", deleted: true }`. |

Create body:

```json
{
  "product_id": "prod_01...",
  "variant_ids": ["variant_01..."],
  "title": "Album digital delivery",
  "description": "MP3 and FLAC release",
  "status": "draft",
  "delivery_type": "download",
  "fulfillment_strategy": "payment_captured",
  "download_limit": 5,
  "expires_in_days": null,
  "preview_enabled": true,
  "update_policy": "purchased_release",
  "metadata": {}
}
```

`delivery_type` is `download`, `stream`, `license`, or `mixed`.
`fulfillment_strategy` is `payment_captured`, `order_completed`, or `manual`.
Patch accepts a non-empty subset of the create fields.

### Releases, assets, and uploads

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/admin/digital-downloads/releases` | Filters: `product_config_id`, `status`, pagination. Returns `{ releases, count, limit, offset }`. |
| `POST` | `/admin/digital-downloads/releases` | Create a `draft` or `ready` release; returns `201 { release }`. |
| `GET` | `/admin/digital-downloads/releases/:id` | `{ release }` with safe asset relations. |
| `PATCH` | `/admin/digital-downloads/releases/:id` | Patch mutable release fields. |
| `DELETE` | `/admin/digital-downloads/releases/:id` | Delete a permitted draft release. |
| `POST` | `/admin/digital-downloads/releases/:id/publish` | `{ make_active?, notify_existing_customers? }`; returns `{ release }`. |
| `GET` | `/admin/digital-downloads/assets` | Filters: `release_id`, `product_config_id`, `role`, `status`, `mime_type`, pagination. |
| `GET` | `/admin/digital-downloads/assets/:id` | `{ asset }`, with storage secrets omitted. |
| `PATCH` | `/admin/digital-downloads/assets/:id` | Patch mutable display/classification fields. |
| `DELETE` | `/admin/digital-downloads/assets/:id` | Delete/retire an asset when its state permits. |
| `POST` | `/admin/digital-downloads/uploads` | Create a streamed-local or presigned-S3 upload intent; returns `201 { upload }`. |
| `PUT` | `/admin/digital-downloads/uploads/:id/content` | Stream bytes for a local-storage intent; returns `202 { upload }`. |
| `POST` | `/admin/digital-downloads/uploads/:id/complete` | Verify a staged object and create its immutable asset; returns `201 { asset }`. |

A release create body includes `product_config_id`, `version`, `title`, and
optional `notes`, `status`, `asset_ids`, `publish_at`, and `metadata`.
Publication is a domain transition, not an ordinary status patch.

Asset roles are `download`, `stream`, `preview`, `cover`, `manual`, and
`license`. The `preview` and `cover` roles are public; every other role is
protected. The completed upload creates the asset; the asset patch route
changes only permitted display/classification metadata.

For a JSON upload intent, send:

```json
{
  "release_id": "drel_01...",
  "filename": "album.zip",
  "mime_type": "application/zip",
  "size": 123456,
  "checksum_sha256": "64-lowercase-or-uppercase-hex-characters",
  "storage_provider": "s3",
  "purpose": "download"
}
```

`purpose` defaults to `download` and accepts `download`, `stream`, `preview`,
`cover`, `manual`, or `license`. Only `preview` and `cover` result in public
preview media; there is no `public`, `asset`, or `key_import` purpose.

The response contains a short-lived `PUT` URL, required headers, and expiry.
For local storage, send bytes to the returned plugin content route with the
returned `x-digital-upload-token` and exact `Content-Length`; the server hashes
while streaming to a temporary file and atomically promotes it. For S3, `PUT`
directly to the presigned private-bucket URL using exactly the signed headers.
Do not add headers that were not part of the signature.

After the PUT succeeds, call the completion route with a non-empty JSON body.
It accepts an optional `release_id`, optional purpose override using the same
enum, and any available checksum, size, ETag, or multipart part ETags. A
`release_id` already recorded by the upload intent need not be repeated.
Completion verifies the object before creating an immutable asset. The upload
intent, module option, Admin setting, proxy, storage provider, and route each
can impose a limit; the most restrictive value wins. The v1 hard route ceiling
is 5 GiB.

### License policies and pooled keys

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` / `POST` | `/admin/digital-downloads/license-policies` | List or create policies. |
| `GET` / `PATCH` / `DELETE` | `/admin/digital-downloads/license-policies/:id` | Retrieve, update, or delete/archive a policy. |
| `GET` | `/admin/digital-downloads/license-policies/:id/keys` | Safe, paginated key inventory filtered by status. |
| `POST` | `/admin/digital-downloads/license-policies/:id/keys` | Import up to 5,000 pooled keys using `{ keys, duplicate_policy }`. |

A policy is associated with one digital product configuration and selects
`strategy: "none" | "pool" | "generated"`. It can define an
activation limit, validity period, required-device-ID policy, and generated-key
pattern. `allow_offline_activation` may be omitted or `false`; version 1 does
not issue an offline validation token. Imported keys belong directly to the
policy; there is no separate public license-pool resource.

Version 1 does not expose an external-provider strategy through this HTTP
contract. Import externally generated inventory into a `pool` policy, or build
and test a separate trusted adapter before extending both the validators and
fulfillment workflow.

Imported keys are secret input. They are encrypted/hashed before persistence
and never returned as a plaintext list. `duplicate_policy` is `reject` or
`skip`. Use a trusted Admin connection, avoid browser/network capture tooling,
and destroy staging copies after verifying the import result.

### Entitlements, downloads, and audits

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/admin/digital-downloads/entitlements` | Filters include order, line item, customer, product/config/variant, status, and pagination. |
| `GET` | `/admin/digital-downloads/entitlements/:id` | `{ entitlement }` using an Admin-safe projection. |
| `POST` | `/admin/digital-downloads/entitlements/:id/revoke` | `{ reason, notify? }`; returns `{ entitlement }`. |
| `POST` | `/admin/digital-downloads/entitlements/:id/reissue` | `{ reason?, notify?, reset_downloads?, rotate_guest_token? }`; returns `{ entitlement }`. |
| `POST` | `/admin/digital-downloads/orders/:order_id/issue` | Reconcile/issue one Medusa order; returns `202 { operation }`. |
| `GET` | `/admin/digital-downloads/downloads` | Filters: entitlement, asset, customer, status, `from`, `to`, pagination. |
| `GET` | `/admin/digital-downloads/audit-events` | Filters: entity type/ID, action, actor, `from`, `to`, pagination. |

Revoke and reissue are audited domain actions. Revoke invalidates active
grants/sessions and can trigger a notification. Reissue can rotate guest access and
optionally reset logical download counters. Neither route should be emulated by
editing entitlement rows directly.

### Guest notification delivery safety

Guest-capability emails are delivered with a short-lived bearer token only for the
provider hand-off. The outbox keeps a token-free checkpoint, redacts the persisted
Medusa notification data immediately afterwards, and records the redacted send
before marking the delivery sent. A retry revokes any previously prepared session
before minting a new attempt-scoped session and notification idempotency key.

If the provider outcome is uncertain, a retry can result in more than one email.
Earlier attempt tokens are revoked before the retry proceeds. If revocation cannot
be confirmed, the delivery is dead-lettered rather than issuing another token.

Order issue is an operator reconciliation endpoint, not a storefront checkout
endpoint. Normal entitlement creation is driven by Medusa order/payment events
and idempotent workflow state.

## Rate limiting

Guest access/grant and public license lifecycle routes are rate-limited by
actor or privacy-preserving network key. Responses can include
`X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`.

The built-in v1 limits per keyed bucket are:

| Operation | Limit / one-minute window |
| --- | --- |
| guest access exchange | 20 |
| guest grant creation | 20 |
| public preview transfer | 120 |
| protected content transfer | 240 |
| license reveal | 20 |
| license activate or deactivate | 30 each |
| license heartbeat or validate | 120 each |

The API first tries a distributed limiter registered in the Medusa container
as `digitalDownloadsRateLimiter`, `rateLimiter`, or
`distributedRateLimiter`. Without one, it uses bounded process-local buckets.
That fallback resets on restart and does not coordinate multiple instances;
configure a distributed implementation for production clusters.

Set a stable `DIGITAL_DOWNLOADS_PRIVACY_SALT` so keyed IP/user-agent
fingerprints remain useful across restarts without storing raw values. Configure
trusted-proxy handling at the host/infrastructure layer before relying on
client IPs.

## Compatibility and evolution

Version 1 clients should:

- ignore additive response fields;
- use documented status strings and not depend on database enum names;
- treat IDs, guest tokens, grant tokens, and license keys as opaque;
- retry only idempotent operations and only with the same key/payload;
- honor `Retry-After`, expiry, revocation, and no-store headers;
- use [STOREFRONT.md](STOREFRONT.md) for safe browser/BFF transfer patterns.

Breaking route or field changes require a major package version. Additive
fields and new optional endpoints can ship in a minor version. Security fixes
may tighten validation or authorization in a patch release.
