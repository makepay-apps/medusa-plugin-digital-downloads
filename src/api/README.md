# Digital Downloads API

This directory contains the Medusa v2 Store and Admin routes for the Digital
Downloads module. The complete versioned contract is in
[`openapi/openapi.yaml`](../../openapi/openapi.yaml).

## Route groups

- `/store/digital-downloads/products/:variant_id` and `/previews/:asset_id`
  expose sanitized catalog and explicitly public preview content.
- `/store/digital-downloads/library`, `/entitlements`, and `/guest/*` expose a
  buyer's durable entitlements and mint short-lived, asset-scoped grants.
- `/store/digital-downloads/content/:asset_id` proxies protected bytes. Grants
  are bearer-only, never accepted in query strings, and a transfer is counted
  only after its response pipeline completes successfully. Local and S3
  objects are Node `Readable` streams with backpressure; there is no protected
  `HEAD` or presigned S3 `GET` in version 1.
- `/store/digital-downloads/licenses/*` implements reveal, activation,
  deactivation, heartbeat, and validation. Submitted keys and device/network
  fingerprints are never echoed.
- `/admin/digital-downloads/*` implements settings, product configurations,
  immutable release history, assets, uploads, license policies/pooled keys,
  entitlements, audit events, downloads, and reports.

## Authentication and capabilities

Admin routes require Medusa Admin authentication. Customer library routes
require a customer bearer/session. Guest purchase tokens are accepted only in
JSON bodies. Content grants are accepted only as `Authorization: Bearer ...`.
The local upload endpoint additionally requires the one-time
`x-digital-upload-token` returned by its upload intent.

Responses are explicit projections. Storage keys and topology (including
buckets, paths, endpoints, and prefixes), credentials, token/key ciphertext or
hashes, device/IP/user-agent hashes, and secret fingerprints are removed
recursively. Sensitive responses use
`Cache-Control: private, no-store, max-age=0`.

## Upload contract

Create an intent with `filename`, `mime_type`, exact `size`, and one purpose:
`download`, `stream`, `preview`, `cover`, `manual`, or `license`. `release_id`
is optional until completion. Both local and S3 intents use `PUT` and include
the exact required headers. The maximum accepted object is 5 GiB, further
bounded by persisted settings.

Local uploads are raw `application/octet-stream` (or the MIME type declared by
the intent), require exact `Content-Length` and `Content-Type`, and stream to a
temporary object while hashing before atomic promotion; the API never buffers
the whole body. S3 intents are presigned with the expected content length.
Complete the intent with at least one completion field and repeat `purpose`
when assigning a non-default role.

## Settings

`PATCH /admin/digital-downloads/settings` changes persisted policy only:
enablement, default delivery/download policy, grant TTLs, upload limit, guest
and email-match policy, retention, and metadata. Deployment storage is read-only
and returned only as `{ storage: { provider, configured } }`; paths, buckets,
regions, endpoints, prefixes, and path-style settings are never returned.
Allowed MIME types and non-secret readiness flags are read-only because they
come from module options/environment. Secrets are represented only by
configured/not-configured booleans.

## Rate limits

Per client, per minute defaults are: guest access 20, guest grant 20, preview
120, protected content 240, license reveal 20, activation 30, deactivation 30,
heartbeat 120, and validation 120. Limits are process-local unless the host
replaces the middleware store with a shared implementation.

## Historical integrity

Published releases and assets attached to published releases are immutable.
Current or published releases cannot be deleted. Asset deletion is retirement,
preserving purchase history and existing entitlement references.
