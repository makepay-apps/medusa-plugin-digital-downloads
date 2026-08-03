# Packed Medusa fixture E2E

These scripts install an already-built npm tarball into a marked disposable
Medusa 2.18 fixture and exercise the real backend, embedded Admin, storefront,
PostgreSQL, protected storage, checkout, automatic subscriber fulfillment,
entitlement, download, license, registered and guest email delivery, notification
retry, refund, cancellation, and active customer-showcase paths.
The exact tarball is installed into both backend and storefront workspaces. A
fixture-only Next.js route imports the package's public `./storefront` export,
calls the live product and customer-library APIs through its client, and renders
the account library, order-scoped downloads, license controls, and a sanitized
delivery-email preview. The order view uses the package's exported
`DigitalOrderDownloads`, and the email view renders the provider-produced HTML
inside an empty-sandbox iframe after checking a strict inert-content contract.
The storefront build/runtime check is therefore a real package-consumer test
rather than a generic starter smoke test.

The generated backend also registers a fixture-only Medusa email provider. It
captures provider-bound messages below the current private run directory,
forces one registered showcase message to fail once, and verifies the plugin's
real retry subscriber completes it on the second attempt. A guest capability is
read from that provider boundary, used against the public guest API, and its
mode-0600 capture is deleted immediately. Registered-customer captures retained
for the sanitized browser preview contain no bearer capability or license key.

The runner is deliberately fail-closed:

- `E2E_FIXTURE_ROOT` is required, must be absolute and narrow, and must contain
  `medusa-app/FIXTURE.md` identifying a **Digital Downloads E2E Fixture**;
- backend, storefront, PostgreSQL, and MinIO are fixed to ports 9100, 8000,
  55432, and 9400/9401 respectively;
- an occupied application or MinIO port aborts the run rather than stopping or
  reusing an unknown process;
- the long-running development Medusa service on port 9000 is never inspected,
  changed, started, or stopped;
- no database is dropped or reset, and every commerce record uses a unique run
  identifier;
- only the processes started by the current invocation are stopped;
- the generated fixture is guarded by `DIGITAL_DOWNLOADS_E2E=1` and overrides
  Medusa's production `Secure` session-cookie default only because its fixed
  Admin origin is loopback HTTP, allowing authenticated browser verification;
- retained services are identified by a private ownership marker, PID, command,
  and recorded process start time before the stop helper can signal them;
- logs, PIDs, receipts, email captures, and redacted evidence are written below
  the fixture's private `runtime/` directory with owner-only permissions, while
  raw guest capabilities use short-lived mode-0600 files that are deleted
  immediately after use;
- the email-preview route is enabled only for this loopback E2E process and
  authorizes the requested order against the signed-in customer's real Store
  library before returning a capability-free projection.

Run local storage and S3-compatible storage as separate release gates:

```bash
export E2E_FIXTURE_ROOT=/absolute/path/to/marked-disposable-fixture

scripts/e2e/run-packed-e2e.sh \
  --tarball /absolute/path/to/makecrypto-medusa-plugin-digital-downloads-0.4.0.tgz \
  --storage local

scripts/e2e/run-packed-e2e.sh \
  --tarball /absolute/path/to/makecrypto-medusa-plugin-digital-downloads-0.4.0.tgz \
  --storage s3
```

Use `--keep-running` only when a subsequent browser test or documentation
screenshot needs the same seeded run. The runner leaves one paid, active
showcase entitlement untouched and writes its customer email, password, order
ID, variant ID, and storefront path to the private mode-0600
`showcase-credentials.json` receipt in the printed run directory. That receipt
is disposable test data: never copy it into documentation, logs, or source
control. Stop the recorded processes with the same fixture-root environment:

```bash
scripts/e2e/stop-fixture.sh /absolute/path/to/fixture/runtime/run-id
```

`--skip-storefront` is available for a backend-only diagnostic run, but it does
not satisfy the complete v0.4.0 release gate.

The scripts never pack the working tree themselves. Passing the exact tarball
that will be released ensures migrations, backend and storefront package
exports, compiled Admin extensions, and runtime dependencies are tested as
consumers receive them. The private `result.json` records sent registered and
guest messages, the two-attempt retry, the active showcase order, and the
credential-receipt filename without persisting customer bearer tokens, guest
capabilities, or plaintext license keys. In S3 mode the setup also applies and
verifies a narrow loopback-only CORS policy for direct browser uploads while
retaining a private, policy-free bucket.
