# Digital Downloads test matrix

This matrix is the release-oriented contract for the plugin test suite. A test
that needs PostgreSQL, a Medusa application, or S3 must fail with a clear
prerequisite error when that dependency is unavailable; it must not silently
return and report success.

Canonical vocabulary used by every layer:

- delivery type: `download | stream | license | mixed`;
- release status: `draft | ready | published | retired`;
- asset role: `download | stream | preview | cover | manual | license`.

## Frozen release-regression tranche

| Layer | Frozen contract | Executable coverage |
| --- | --- | --- |
| Unit/crypto | independently constructed canonical v1 AES-GCM envelope; old/new key behavior; malformed and non-canonical base64url rejection | `tests/security.unit.spec.ts` |
| Unit/local storage | unsafe, broad, permissive, and symlink roots fail closed; validated handles cannot be replaced; truncation before expected EOF fails | `tests/local-storage.unit.spec.ts` |
| Unit/S3 storage | signed length, checksum, content type, and create-only headers are exact; request, signer, checksum, and late-stream errors are redacted and release resources | `tests/s3-storage.unit.spec.ts` |
| Unit/loader | persisted storage, token-secret, and encryption-key fingerprints cannot rotate while dependent rows exist; an empty installation updates them together | `tests/loader-rotation.unit.spec.ts` |
| PostgreSQL module | published history and pinned releases are immutable; quantity cap is pre-allocation; complete grant fingerprint and omitted-default replay; revoke/complete race and event transitions; bounded range continuation; guest capability hashing/reissue; settings singleton; required device IDs; atomic pool import | `integration-tests/modules/domain-regressions.integration.spec.ts` |
| S3-compatible integration | real endpoint put/exists/range/presign behavior with delete cleanup; explicitly skipped unless all MinIO credentials are supplied | `integration-tests/modules/s3-minio.integration.spec.ts` |

## P0 release gates

| Layer | Executable contract | Coverage |
| --- | --- | --- |
| Unit/security | Opaque capabilities, context-separated keyed hashes, AES-GCM license envelopes, tamper/wrong-key rejection, projections, and redaction | `tests/security.unit.spec.ts`, `tests/api-security.unit.spec.ts` |
| Unit/configuration and storage | Bounded options, safe local roots and handles, symlink/traversal rejection, exact ranges/checksums, S3 create-only uploads, late-stream errors, and resource cleanup | `tests/options.unit.spec.ts`, `tests/local-storage.unit.spec.ts`, `tests/s3-storage.unit.spec.ts` |
| Unit/API and delivery | Validation, Admin/store projections, native ProductVariant link keys, unknown/foreign-resource behavior, private headers, range accounting, disconnect races, and no secret-bearing URLs | `src/api/__tests__/*.unit.spec.ts`, `tests/store-handlers.unit.spec.ts` |
| Unit/workflows | Native link creation and lookup, immutable publication, exactly-once quantity fulfillment, compensation, retry claims, notification redaction, revocation/reissue, cleanup, schedules, and optional fulfillment provider | `src/workflows/digital-downloads/__tests__/*.unit.spec.ts`, `src/subscribers/__tests__/*.unit.spec.ts`, `src/jobs/__tests__/schedules.unit.spec.ts`, `src/providers/digital-fulfillment/__tests__/service.unit.spec.ts` |
| Unit/storefront | Typed transport/client errors and accessible React loading, empty, revoked, expired, download, preview, license, and attribution states | `src/storefront/__tests__/*.unit.spec.ts` |
| PostgreSQL module | Real migrations and constraints, immutable/pinned releases, one entitlement per order-line-unit, idempotent grants, concurrent transfer accounting, guest rotation, transactional license allocation/activation, and reports | `integration-tests/modules/digital-downloads.integration.spec.ts`, `integration-tests/modules/domain-regressions.integration.spec.ts` |
| Built-plugin HTTP | Packaged plugin boot, fixed attribution, Admin/store authentication, secret-free settings, malformed guest/grant rejection, and indistinguishable unknown ProductVariant mappings | `integration-tests/http/routes-security.spec.ts` |
| S3-compatible integration | Real MinIO put/exists/range/presign/delete behavior and prefix isolation when explicit disposable credentials are supplied | `integration-tests/modules/s3-minio.integration.spec.ts` |
| Packed Medusa lifecycle | Clean tarball installation, migrations, embedded Admin/server/storefront builds, native product/release/upload/publish, paid quantity checkout, duplicate/concurrent issue, cross-customer denial, ranges/streams, transfer races, licenses, reissue, refund, guest access, cancellation, and secret-free reports | `scripts/e2e/run-packed-e2e.sh`, `scripts/e2e/lifecycle.mjs` |
| Package consumer | Strict NodeNext resolution from the actual tarball for module, legacy module path, workflows, provider, and storefront; package residue/allowlist assertions | `scripts/test-packed-types.mjs` |

## P1 operational gates

| Layer | Contract | Required assertions |
| --- | --- | --- |
| PostgreSQL migrations | clean install, repeated up, supported upgrade fixture, indexes/checks present, preserved encrypted and audit data |
| S3-compatible storage | MinIO write/read/delete, prefix isolation, range reads, presign TTL, missing object, checksum mismatch, credentials absent from errors |
| Packed plugin | `npm pack` allowlist, install into clean Medusa v2 fixture, migrations, DI boot, Admin/server and storefront builds, simulated purchases and lifecycle actions |
| Compatibility | minimum supported Medusa v2 and current supported v2, supported Node versions, PostgreSQL matrix |
| Browser | Embedded Admin and supplied storefront presentation routes, with API-level merchant/customer lifecycle coverage and focused component accessibility tests |

## Test data and reset rules

- Each PostgreSQL suite uses a uniquely named database or schema and resets all
  state between tests.
- Time-dependent tests inject or freeze time; they do not sleep.
- Concurrent cases use barriers and bounded timeouts so both transactions reach
  the contested operation before either is released.
- Test records use distinct customer, order, line-item, variant, entitlement,
  asset, grant, assignment, and instance identifiers. Assertions always include
  the tenant/owner boundary, not only row counts.
- Secrets in fixtures are synthetic and assertions verify they are absent from
  serialized responses, error messages, audit metadata, and persisted public
  fields.
