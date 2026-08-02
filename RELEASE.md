# Release guide

This guide is for maintainers of
`@makecrypto/medusa-plugin-digital-downloads`. The package follows Semantic
Versioning and publishes from tags shaped as `v<package-version>`.

## Release invariants

A release is blocked unless:

- the package version, changelog entry, Git tag, and release title agree;
- the tagged commit is reachable from the current `origin/main` history;
- CI is green on the exact commit being tagged;
- clean PostgreSQL install and supported upgrade migrations pass;
- the packed tarball contains the runtime server, Admin, storefront, migration,
  documentation, license, and security files required by the package;
- the GitHub release contains the tarball, its SHA-256 checksum, its CycloneDX
  SBOM, and a verifiable GitHub build-provenance attestation;
- the tarball installs and boots in a clean supported Medusa application;
- local and S3 smoke scenarios pass for a release that changes storage or
  delivery code;
- no plaintext credential, download token, guest capability, private object
  key, or license key appears in the artifact or test logs.

The package declares Node.js 20+ and Medusa v2 peer ranges in `package.json`.
CI currently exercises Node.js 20 and 22. A peer-range change requires a host
compatibility test, not only a TypeScript build.

## 1. Prepare the release

1. Start from an up-to-date, conflict-free branch.
2. Choose the next version using Semantic Versioning.
3. Update `package.json` and `package-lock.json` together.
4. Add a dated entry to `CHANGELOG.md` describing user-visible changes,
   migrations, deprecations, and security fixes.
5. Update the configuration, API, Admin, storefront, and migration guides when
   their contracts changed.
6. Review dependency and license changes.

Do not rewrite a migration that has already shipped. Add a new migration and
document its forward and rollback behavior.

## 2. Verify source and database behavior

Run the source gate:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Run both PostgreSQL suites against a disposable database:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/medusa_digital_downloads_release
export DB_HOST=localhost
export DB_PORT=5432
export DB_USERNAME=postgres
export DB_PASSWORD=postgres
export JWT_SECRET=release-test-secret
export COOKIE_SECRET=release-test-secret
export DIGITAL_DOWNLOADS_ENCRYPTION_KEY="$(openssl rand -hex 32)"

npm run test:integration:modules
npm run test:integration:http
```

For a storage-affecting release, also set the disposable
`DIGITAL_DOWNLOADS_MINIO_ENDPOINT`, `DIGITAL_DOWNLOADS_MINIO_BUCKET`,
`DIGITAL_DOWNLOADS_MINIO_ACCESS_KEY_ID`, and
`DIGITAL_DOWNLOADS_MINIO_SECRET_ACCESS_KEY` values described in
[CONTRIBUTING.md](CONTRIBUTING.md), then rerun the module suite. Confirm the
MinIO tests ran; their intentional missing-environment skip does not satisfy a
release gate.

For migration-bearing releases, rehearse both paths:

- a clean database installing the candidate package;
- a database on the latest published version upgraded to the candidate.

Back up the upgrade fixture before migration and verify that the documented
rollback procedure actually restores service.

## 3. Inspect and smoke-test the artifact

Create the same npm artifact users will install:

```bash
npm pack --dry-run --json
npm pack
```

Inspect the JSON/file list and then install the resulting `.tgz` into a clean
Medusa host. Register the plugin, run `npx medusa db:migrate`, build the host,
and boot it. At minimum verify:

- the Digital Downloads module resolves;
- the Admin bundle loads without console errors;
- public preview routes do not expose protected storage fields;
- authenticated and guest ownership boundaries reject another buyer's IDs;
- a duplicate fulfillment event does not duplicate ownership or license keys;
- download grants expire and revoked/refunded ownership cannot create new
  grants;
- private local and S3 objects remain inaccessible without authorization.

Delete the local `.tgz` after verification or leave it untracked.

## 4. Merge and tag

Merge the reviewed release pull request to `main`, verify the required CI jobs
on the merge commit, then create and push the exact version tag:

```bash
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin v0.3.0
```

Replace `0.3.0` with the prepared package version. Do not reuse or move a
published tag.

Before setup, installation, build, or publication, the tag workflow fetches
`origin/main` and verifies that the tagged commit is reachable from that branch.
It then checks that the tag matches `package.json`, runs `npm run check`, creates
the tarball plus a SHA-256 checksum and CycloneDX SBOM, attests the tarball with
GitHub build provenance, and publishes all three files in a GitHub release.
Release Actions are pinned to reviewed commit SHAs. It runs
`npm publish --provenance --access public` only when the repository has an
`NPM_TOKEN` secret. The integration CI result for the same commit must already
be green before tagging.

## 5. Post-release verification

After the workflow completes, download these version-matched GitHub release
assets:

- `makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz`;
- `makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz.sha256`;
- `makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz.sbom.cdx.json`.

Then:

1. Verify the tarball against its companion checksum with
   `shasum -a 256 -c makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz.sha256`.
2. Verify GitHub build provenance with
   `gh attestation verify makecrypto-medusa-plugin-digital-downloads-0.3.0.tgz --repo makepay-apps/medusa-plugin-digital-downloads`.
3. Parse/review the CycloneDX SBOM and confirm it identifies version `0.3.0`.
4. Compare the verified tarball's file list/content with the inspected
   candidate, install that tarball in a clean Medusa host, migrate, and run a
   boot/health smoke test.
5. If the optional npm step ran, separately verify npm version/provenance and
   install the exact npm version in a second clean host. A missing `NPM_TOKEN`
   means the GitHub artifact is the release channel; it is not a failed GitHub
   release.
6. Verify documentation links and the changelog.
7. Monitor startup, migration, fulfillment, notification, storage, and grant
   errors during the rollout window.

## Rollback

Application rollback and data rollback are separate decisions.

- Stop workers and writes before changing versions if a migration or event
  contract is involved.
- Preserve the failing deployment's logs and exact package version.
- Restore the previous package and configuration only when its code can read
  the migrated schema.
- If compatibility is not guaranteed, restore the pre-migration PostgreSQL
  backup and storage/configuration snapshot together.
- Do not rotate `DIGITAL_DOWNLOADS_ENCRYPTION_KEY` during rollback. Existing
  encrypted licenses depend on the original key.
- Do not delete or overwrite protected objects created during the failed
  rollout until database references have been reconciled.
- If customers may have received entitlements or keys, run reconciliation
  before retrying fulfillment. Never compensate by blindly replaying every
  order event.

See [docs/MIGRATIONS.md](docs/MIGRATIONS.md) for database-specific procedures.

## Emergency security release

Use the same artifact and migration gates for an emergency patch. Keep public
release notes concise until affected users have an upgrade path, and coordinate
disclosure through the process in [SECURITY.md](SECURITY.md). Never publish
live exploit tokens, credentials, customer identifiers, or recoverable license
material.
