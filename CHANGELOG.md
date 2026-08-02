# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-08-02

### Changed

- Removed pre-release status language from the public README and clarified the
  architecture, installation, and product-roadmap wording.
- Synchronized package, API, OpenAPI, test-fixture, and release-documentation
  metadata for the `0.3.1` patch release.
- Changed npm publication to use the already checked and attested release
  tarball, keeping the npm and GitHub package artifacts byte-identical.

## [0.3.0] - 2026-08-02

### Added

- Initial Medusa v2 digital-products plugin with protected file delivery,
  entitlements, software-license lifecycle management, native Admin extensions,
  storefront primitives, local/S3-compatible storage, and full test tooling.
- Immutable releases, resumable uploads, previews, byte-range streaming,
  revocation/refund handling, download limits, guest sessions, license
  activation limits, audit trails, reconciliation, and bounded retry queues.
- Hardened product configuration, topology-safe Admin diagnostics, fail-closed
  guest-notification capability cleanup, and an explicit packed export surface.
- Reproducible release packaging with checksums, CycloneDX SBOMs, provenance
  attestations, PostgreSQL/MinIO integration coverage, and local/S3 lifecycle
  simulations.
- A forward-compatible settings migration normalizes the exact MakePay
  attribution constraint for databases created by early v1 development builds.
