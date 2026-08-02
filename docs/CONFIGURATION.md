# Configuration

Register the package as a Medusa v2 plugin. Plugin options configure runtime
secrets, storage topology, and hard safety limits; database-managed merchant
settings configure non-secret delivery defaults.

This guide reflects the v1 module option resolver and storage drivers in the
source package. Environment variable names shown here are either read directly
by the plugin or explicitly passed from `medusa-config.ts`.

## Install and register

From the Medusa backend application, install from npm:

```bash
npm install @makecrypto/medusa-plugin-digital-downloads
```

For reproducible deployments, commit your lockfile or pin an approved version.
Verified tarballs, checksums, SBOMs, and provenance are available from
[GitHub Releases](https://github.com/makepay-apps/medusa-plugin-digital-downloads/releases).
Never install a moving branch in production.

Add the plugin to `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  plugins: [
    {
      resolve: "@makecrypto/medusa-plugin-digital-downloads",
      options: {
        // See the local and S3 examples below.
      },
    },
  ],
})
```

Medusa automatically registers modules included by a plugin; do not register
the Digital Downloads module a second time under `modules`.

After changing the installed package or its data models, run from the Medusa
host:

```bash
npx medusa db:migrate
```

## Secrets

Generate independent random values and store them in the deployment's secret
manager:

```bash
openssl rand -hex 32 # DIGITAL_DOWNLOADS_ENCRYPTION_KEY
openssl rand -hex 32 # DIGITAL_DOWNLOADS_TOKEN_SECRET
openssl rand -hex 32 # DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET
openssl rand -hex 32 # DIGITAL_DOWNLOADS_PRIVACY_SALT
```

`DIGITAL_DOWNLOADS_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters,
representing 32 random bytes. The other configured module secrets accept
arbitrary UTF-8 values containing at least 32 bytes. Generate every value
independently; startup rejects an encryption key that is identical to
`tokenSecret`.

| Secret | Purpose | Operational rule |
| --- | --- | --- |
| `encryptionKey` / `DIGITAL_DOWNLOADS_ENCRYPTION_KEY` | AES-256-GCM envelope derivation for recoverable license keys. | Exactly 64 hex characters (32 bytes), dedicated and different from `tokenSecret`. Keep stable and backed up; changing it does not re-encrypt existing data. |
| `tokenSecret` / `DIGITAL_DOWNLOADS_TOKEN_SECRET` | HMACs for opaque grants and privacy-preserving fingerprints. | Required before using grant/token operations. Rotation needs an explicit compatibility plan. |
| `storage.local.signingSecret` / `DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET` | Signs protected local descriptors. | Defaults to `tokenSecret`; a separate value reduces blast radius. |
| `DIGITAL_DOWNLOADS_PRIVACY_SALT` | API-layer keyed hashes for IP/user-agent rate and audit context. | Configure a stable deployment secret. Without it, the process creates an ephemeral salt that changes after restart. |

The module can resolve without every optional secret so installations can use a
subset of features, but the corresponding license, grant, or protected-local
operation fails closed when required key material is absent. Configure all four
for the complete v1 feature set.

Never expose these values through Admin settings, Store API, storefront public
environment variables, logs, or support exports.

## Local protected storage

```ts
{
  resolve: "@makecrypto/medusa-plugin-digital-downloads",
  options: {
    encryptionKey: process.env.DIGITAL_DOWNLOADS_ENCRYPTION_KEY,
    tokenSecret: process.env.DIGITAL_DOWNLOADS_TOKEN_SECRET,
    storage: {
      defaultProvider: "local",
      local: {
        rootPath: process.env.DIGITAL_DOWNLOADS_LOCAL_ROOT,
        signingSecret:
          process.env.DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET,
      },
    },
    defaultDownloadLimit: 5,
    defaultGrantTtlSeconds: 900,
    maxGrantTtlSeconds: 86_400,
    maxUploadSizeBytes: 512 * 1024 * 1024,
    allowedMimeTypes: [
      "application/pdf",
      "application/zip",
      "audio/*",
      "video/*",
      "image/*",
    ],
    allowGuestAccess: true,
  },
}
```

This example deliberately lowers the runtime upload ceiling to 512 MiB; omit
`maxUploadSizeBytes` to use the 5 GiB module default.

`rootPath` must be a dedicated, persistent, private directory. On POSIX, it
must be owned by the Medusa process; a pre-existing root and every subdirectory
below it must be mode `0700` or stricter. The driver refuses broad/shared roots,
including a home directory, the process working directory, temporary
directories, `/var`, `/srv`, and `/mnt`. It also rejects public/static path
segments, system trees, symlinks, and directories owned by another user. Create
a dedicated child such as `/data/medusa-digital-downloads`, set its ownership
and permissions before startup, and keep it outside every reverse-proxy web
root. When omitted,
the resolver uses `<process.cwd()>/.medusa/digital-downloads` as a development
default; configure an absolute production path explicitly.

The local driver:

- canonicalizes every storage key below the configured root;
- rejects absolute paths, empty/dot/parent segments, backslashes, and NULs;
- rejects symlink/non-directory path components;
- creates POSIX directories with mode `0700` and objects with mode `0600`;
- writes through a temporary file and verifies an optional SHA-256 checksum;
- returns a Node `Readable` for a full object or one bounded byte range from the
  already-open, validated `O_NOFOLLOW` file handle;
- enforces the exact byte count, rechecks device/inode/size/mtime and path
  identity at EOF, and closes the handle on EOF, error, or consumer destroy;
- signs internal protected descriptors without making the directory public.

For multiple Medusa API/worker instances, either mount one durable filesystem
with the required consistency/locking semantics on every instance or use S3.
Container-local ephemeral storage is not a production configuration.

Local Admin uploads are written through a bounded stream to a temporary file,
hashed during transfer, and atomically promoted. S3 uploads use a short-lived
presigned `PUT` so object bytes do not pass through the Medusa process. Test the
largest intended protected-content range/file through the real proxy and CDN
path.

Protected local and S3 reads remain Node `Readable` streams through the
same-origin bearer-grant route. The API uses pipeline backpressure and does not
materialize or buffer the response body. It commits grant/download consumption
after authorization and storage-open validation but before response headers or
the first body byte. An accounting failure therefore exposes no protected
bytes. After commit, a disconnect or late storage error remains consumed and is
recorded as a failed transfer. The ordinary programmatic `put(Buffer)` helper
and the storage health probe (capped at 64 KiB) are intentionally buffered
storage paths; protected delivery is not.

## S3 and S3-compatible storage

```ts
{
  resolve: "@makecrypto/medusa-plugin-digital-downloads",
  options: {
    encryptionKey: process.env.DIGITAL_DOWNLOADS_ENCRYPTION_KEY,
    tokenSecret: process.env.DIGITAL_DOWNLOADS_TOKEN_SECRET,
    storage: {
      defaultProvider: "s3",
      s3: {
        bucket: process.env.DIGITAL_DOWNLOADS_S3_BUCKET!,
        region: process.env.DIGITAL_DOWNLOADS_S3_REGION || "us-east-1",
        endpoint: process.env.DIGITAL_DOWNLOADS_S3_ENDPOINT,
        accessKeyId: process.env.DIGITAL_DOWNLOADS_S3_ACCESS_KEY_ID!,
        secretAccessKey:
          process.env.DIGITAL_DOWNLOADS_S3_SECRET_ACCESS_KEY!,
        sessionToken: process.env.DIGITAL_DOWNLOADS_S3_SESSION_TOKEN,
        prefix: process.env.DIGITAL_DOWNLOADS_S3_PREFIX || "digital-downloads",
        forcePathStyle:
          process.env.DIGITAL_DOWNLOADS_S3_FORCE_PATH_STYLE === "true",
        allowInsecureEndpoint: false,
      },
    },
  },
}
```

The v1 driver uses AWS Signature Version 4 with the configured access key,
secret, and optional session token. It supports AWS S3 and compatible services
that accept the same signing/addressing, ranged `GetObject`, and presigned
`PutObject` behavior. Protected `GET` bytes remain behind the plugin route.
Test the exact provider before publishing products.

An S3 `GetObject` body is adapted directly to a sanitized Node `Readable`; the
driver never calls `transformToByteArray`. It validates `Content-Length`,
`Content-Range`, and the exact streamed byte count, destroys the provider body
when the consumer aborts, and replaces late SDK errors with safe errors that do
not retain raw provider response/credential context.

S3 option/environment precedence is:

- explicit `storage.s3.*` option;
- matching `DIGITAL_DOWNLOADS_S3_*` environment value where supported;
- documented resolver default.

`forcePathStyle` and `allowInsecureEndpoint` are configuration options, not
automatically parsed from environment variables. The example performs its own
boolean conversion for `forcePathStyle`.

### S3 rules

- `bucket`, `accessKeyId`, and `secretAccessKey` are required when S3 is
  configured.
- `region` defaults to `us-east-1`.
- With no endpoint, the resolver uses
  `https://s3.<region>.amazonaws.com`.
- An endpoint must be an absolute HTTP(S) URL and cannot contain credentials,
  query parameters, or a fragment.
- HTTP is rejected unless `allowInsecureEndpoint: true` is set explicitly.
  Use that escape hatch only for isolated local development such as MinIO.
- `prefix` has leading/trailing slashes removed and cannot contain `..`
  segments.
- The bucket must remain private. Admin uploads can use a short-lived presigned
  `PUT`; customer downloads use the plugin's bearer-grant content route rather
  than a public object URL.
- Credentials should have only the object actions required beneath the
  configured bucket/prefix. Use a distinct production principal.
- Because Admin uploads use a direct presigned `PUT`, configure bucket CORS for
  the exact Admin origins, `PUT`, the returned signed headers (normally
  `content-type` and optional checksum headers), and `ETag` exposure when the
  provider requires it. Do not enable anonymous `GET` to make uploads work.
- Prefer bucket default server-side encryption, versioning/retention matched to
  recovery requirements, and lifecycle cleanup for abandoned staging objects.

SHA-256 is checked at upload/completion and again when the immutable release
manifest is published. Delivery validates storage size, range, status, and
manifest metadata without re-reading or buffering an entire object to hash it.
Prevent out-of-band mutation of published keys with least-privilege IAM and
bucket versioning/retention.

The shipped module-option contract uses explicit access credentials; it does
not currently expose a default AWS credential-chain or KMS-key option. Those
fields may appear in future roadmap/API schemas but should not be documented as
operational until implemented by the storage driver.

For MinIO, Cloudflare R2, DigitalOcean Spaces, Supabase's S3 endpoint, or
another compatible service, use its documented endpoint/region/credential
values and enable path style only when the provider requires it. Never copy a
public asset URL into `endpoint`.

## Module options

| Option | Default | Notes |
| --- | --- | --- |
| `storage.defaultProvider` | `"local"` | `"local"` or `"s3"`. S3 configuration must be complete before selecting it. |
| `storage.local.rootPath` | `<cwd>/.medusa/digital-downloads` | Resolved to an absolute path. Specify explicitly in production. |
| `storage.local.signingSecret` | `DIGITAL_DOWNLOADS_LOCAL_SIGNING_SECRET`, then `tokenSecret` | At least 32 bytes before protected descriptor use. |
| `storage.s3.bucket` | none | Required for S3; strict S3-style bucket validation. |
| `storage.s3.region` | `us-east-1` | AWS signing region. |
| `storage.s3.endpoint` | AWS regional endpoint | HTTPS by default. |
| `storage.s3.accessKeyId` | environment fallback | Required for S3. |
| `storage.s3.secretAccessKey` | environment fallback | Required for S3; never returned by Admin API. |
| `storage.s3.sessionToken` | environment fallback | Optional temporary credential component. |
| `storage.s3.forcePathStyle` | `false` | Enable only when the S3-compatible provider requires path-style addressing. |
| `storage.s3.allowInsecureEndpoint` | `false` | Development-only explicit HTTP escape hatch. |
| `storage.s3.prefix` | empty | Private object namespace inside the bucket. |
| `tokenSecret` | environment fallback | At least 32 bytes when supplied. |
| `encryptionKey` | environment fallback | Exactly 64 hexadecimal characters representing 32 bytes; must differ from `tokenSecret`. |
| `defaultDownloadLimit` | `5` | `null` means unlimited; `0` permits no logical downloads. Maximum 1,000,000. |
| `defaultGrantTtlSeconds` | `900` | 30 seconds through 7 days. |
| `maxGrantTtlSeconds` | `86400` | Must be at least the default and at most 7 days. |
| `maxUploadSizeBytes` | 5 GiB | Runtime ceiling, up to the v1 hard maximum of 1 TiB. Upload intents/routes, Admin settings, proxies, and storage providers can impose lower limits. |
| `allowedMimeTypes` | empty allowlist | Empty or `*/*` accepts any syntactically valid MIME; supports exact types and `type/*`. |
| `allowGuestAccess` | `true` | Enables module guest policy; routes still validate explicit guest capabilities. |
| `refundPolicy` | `"full_refund"` | `retain`, `any_refund`, `full_refund`, `refunded_items`, or `all`. |
| `cancellationPolicy` | `"all"` | `retain` preserves access; other current values revoke on cancellation. |

Module options override their supported environment fallbacks.

The module records a non-secret storage-namespace fingerprint derived from the
local root and configured S3 endpoint/bucket/prefix. Credentials and signing
secrets are excluded. After any asset or upload row exists, startup fails if
that physical namespace changes; run an explicit storage migration rather than
silently pointing historical locators at a different directory or bucket.

## Database-managed settings

The module models non-secret global settings for enabled state, default
delivery mode, download limit, grant TTL ceiling, upload limit, guest access,
order-email matching, audit retention, and MakePay attribution visibility.
Runtime storage credentials and encryption/token secrets are not safe
database-managed Admin fields.

`require_order_email_match` defaults to `true`. With that policy enabled, the
guest access, guest grant, and guest license-reveal bodies must supply the order
email (`email` or `guest_email`, as documented by the route). Missing and
mismatched values use the same unauthorized envelope as an invalid capability,
and storefronts should prompt for the email rather than putting it in a link.

`event_retention_days` records the merchant's retention target. Version 1 does
not automatically purge download/license audit history at that age; implement
an approved export/purge process for regulatory deletion requirements. The
daily cleanup job expires capabilities and reconciles orphaned product state,
not durable audit records.

The attribution text and URL are fixed when present:
[Brought to you by MakePay.io — crypto payment gateway.](https://makepay.io)
Arbitrary attribution HTML or destinations are rejected.

If an Admin setting and a hard module option both impose a limit, use the more
restrictive effective value. Changing a current default must not mutate the
immutable policy snapshot of an existing entitlement.

## Fulfillment and revocation policy

Digital product configurations select `payment_captured`, `order_completed`,
or `manual` fulfillment. The plugin also listens to `order.placed`; a
configuration without an explicit strategy is eligible on that signal.
Repeated placed/completed/captured events are reconciled through the same
durable fulfillment operation rather than treated as separate purchases.

Subscriber revocation policy is configured with the typed plugin options:

```ts
{
  resolve: "@makecrypto/medusa-plugin-digital-downloads",
  options: {
    refundPolicy: "full_refund",
    cancellationPolicy: "all",
    // storage, secrets, and limits...
  },
}
```

`refundPolicy` accepts:

- `retain`: do not revoke on a payment refund;
- `any_refund` or `all`: revoke all non-terminal entitlements on any refund;
- `full_refund` (default): revoke only when aggregate refunds cover the order
  total;
- `refunded_items`: revoke only explicitly supplied line-item IDs.

The standard `payment.refunded` event supplies a payment ID, not refunded line
IDs. Therefore `refunded_items` safely retains access for that ordinary event;
use it only with a reviewed line-aware adapter that invokes the revocation
workflow with `line_item_ids`. It does not infer refunded items from amounts.

`cancellationPolicy` defaults to `all`. For an order-cancellation trigger,
`retain` preserves access and every other current value revokes all
non-terminal entitlements. Chargeback/dispute signals always revoke all.

Retry schedules and maximum attempts are fixed in v1: fulfillment
reconciliation every five minutes, notification delivery every two minutes,
and eight attempts before durable dead-letter state. Monitor those records and
repair the underlying cause before replaying work.

### Optional native fulfillment provider

Register the zero-cost provider only when digital delivery should appear in
Medusa's native fulfillment/shipping-option UI:

```ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          {
            resolve:
              "@makecrypto/medusa-plugin-digital-downloads/providers/digital-fulfillment",
            id: "makepay-digital",
          },
        ],
      },
    },
  ],
})
```

The provider exposes option ID `digital-delivery`, calculates a zero price,
and records native fulfillment acknowledgement/cancellation data. Entitlement
issuance still comes from the order/payment workflows, so registering this
provider does not change the selected fulfillment strategy or override cart
completion.

Registering a provider does not safely scope a Medusa shipping option by
itself. Configure its fulfillment set, service zone, and storefront eligibility
so a zero-cost digital option is not offered as the only fulfillment choice for
physical items. Mixed carts still need their normal physical shipping and
fulfillment path.

### Notification Module and scheduled jobs

Delivery, revocation, reissue, and expiry emails are submitted through
Medusa's normal Notification Module using these template identifiers:

- `digital-downloads-delivery`
- `digital-downloads-revoked`
- `digital-downloads-reissued`
- `digital-downloads-expired`

Configure a Medusa email notification provider and matching templates in the
host application. The plugin stores recipient hashes and delivery/outbox state;
the Notification Module remains responsible for provider credentials,
rendering, and transport. A missing customer email leaves the notification
undeliverable without exposing the address in operational projections.

For a guest delivery or guest-token rotation, the template invocation receives
a transient `guest_access_token` and the same value as
`guest_access.token`, together with the entitlement snapshot and safe session
metadata. Build the storefront recovery URL in the trusted email template,
prefer a URL fragment, capture/remove it immediately, then prompt for the order
email and exchange the pair as described in the [storefront guide](STOREFRONT.md).
The subscriber redacts the capability from
Medusa's stored Notification record immediately after creation, including
failure paths; the email provider and delivered message still handle secret
material and need appropriate retention/access controls. Customer deliveries
do not receive a guest token.

The plugin also installs non-overlapping scheduled jobs:

| Job | Schedule | Purpose |
| --- | --- | --- |
| `digital-downloads-retry-fulfillment` | every 5 minutes | Reconcile pending/failed/stale fulfillment operations, 25 at a time. |
| `digital-downloads-retry-notifications` | every 2 minutes | Retry due notification outbox rows, 25 at a time. |
| `digital-downloads-expire-entitlements` | hourly at minute 17 | Expire up to 500 due entitlements and enqueue notices. |
| `digital-downloads-cleanup-orphans` | daily at `03:43` | Reconcile up to 1,000 orphaned product links/configurations. |

Each job uses `concurrency: "forbid"` within Medusa's scheduler configuration,
while durable leases/idempotency protect work across retries. Run Medusa's
worker/scheduler role in production and alert on failed/dead-letter state; a
healthy API process alone does not execute scheduled recovery work.

## MakePay payment provider

Digital Downloads does not process payments and does not require MakePay. To
accept MakePay alongside it, install and configure the separate payment
provider under Medusa's Payment Module:

```ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  plugins: [
    {
      resolve: "@makecrypto/medusa-plugin-digital-downloads",
      options: {
        // Digital-download storage and secrets only.
      },
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@makecrypto/medusa-plugin-makepay/providers/makepay",
            id: "makepay",
            options: {
              keyId: process.env.MAKEPAY_KEY_ID!,
              keySecret: process.env.MAKEPAY_KEY_SECRET!,
              webhookSecret: process.env.MAKEPAY_WEBHOOK_SECRET!,
              settlementCurrency:
                process.env.MAKEPAY_SETTLEMENT_CURRENCY || "USDT",
              expirationTime: "12h",
            },
          },
        ],
      },
    },
  ],
})
```

The MakePay provider's default Medusa webhook path is
`/hooks/payment/makepay_makepay`; configure the full HTTPS URL in MakePay and
follow the installed provider README for its current options. Keep all
`MAKEPAY_*` secrets out of Digital Downloads options. The interoperability
boundary is Medusa's normal payment/order lifecycle.

The current MakePay payment provider does not initiate refunds through its v1
Medusa provider method. If an operator or external integration performs a
refund, make sure the resulting Medusa payment state/event is reconciled before
expecting Digital Downloads' refund policy to run. Do not revoke ownership
directly from an unsigned MakePay browser return.

## Storefront and HTTP configuration

- Add each storefront origin to Medusa's Store CORS configuration.
- Use HTTPS for browser, backend, and object-storage traffic.
- Configure the normal Medusa publishable API key for Store routes.
- Configure the normal Medusa customer authentication strategy.
- Put guest purchase capabilities only in POST bodies and content grants only
  in Authorization headers.
- Set a trusted proxy policy at the Medusa/infrastructure layer before relying
  on IP-derived rate limits or audit fingerprints.
- In a multi-instance deployment, register a distributed rate limiter under a
  supported container name such as `digitalDownloadsRateLimiter`. Otherwise
  the API's fallback request buckets are process-local and reset on restart.

## Operational checks

Before publishing the first product:

1. Run migrations and restart all processes.
2. Verify the configured storage provider can write, read, range-read, and
   delete a disposable object.
3. Confirm a protected object cannot be fetched publicly.
4. Upload a file at the maximum intended size and verify its checksum.
5. Test a registered and guest purchase, duplicate event, refund/revocation,
   grant expiry, and download limit.
6. Verify logs, traces, analytics, and error monitoring omit capabilities,
   object keys, credentials, and plaintext licenses.
7. Back up the database, storage namespace, and secret-manager configuration.

## Troubleshooting

### Plugin reports that Digital Downloads is not configured

- Confirm the package name under `plugins`.
- Confirm migrations ran from the Medusa host.
- Confirm all API/worker processes use the same package and configuration.
- Check startup logs for option validation failures.

### Local content cannot be opened

- Use an absolute persistent `rootPath` and grant the Medusa process read/write
  access.
- Confirm no directory component is a symlink.
- Configure a signing secret of at least 32 bytes.
- Confirm every instance mounts the same root when using multiple instances.

### S3 startup validation fails

- Supply bucket, access key, and secret together.
- Check bucket syntax, signing region, endpoint, and path-style requirement.
- Remove credentials/query/fragment from the endpoint URL.
- Use HTTPS or explicitly enable insecure access only in local development.

### Startup reports that the storage namespace changed

- Restore the previous local root or S3 endpoint/bucket/prefix to recover
  normal service.
- Do not bypass the fingerprint by editing its database value.
- Copy and verify every referenced object, update asset locators through a
  reviewed migration, then switch topology as one controlled cutover.
- Credential rotation alone does not change the fingerprint and does not move
  objects.

### S3 returns 403 or signature mismatch

- Verify the endpoint's signing region and the server clock.
- Check prefix permissions and optional session token.
- Toggle `forcePathStyle` only to match the provider.
- Test the same credentials against a disposable object outside customer flow.

### Upload is rejected below the module limit

The upload intent, database-managed Admin setting, HTTP route, reverse proxy,
and storage provider can each impose a lower ceiling than
`maxUploadSizeBytes`. Local uploads also require an exact `Content-Length` that
matches the intent; S3 uploads must preserve the returned signed headers.

### Existing license keys cannot be revealed

Restore the exact encryption key used when the keys were imported or issued.
Do not overwrite ciphertext or rotate the key ad hoc. See
[MIGRATIONS.md](MIGRATIONS.md).
