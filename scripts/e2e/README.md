# Packed Medusa fixture E2E

These scripts install an already-built npm tarball into a marked disposable
Medusa 2.18 fixture and exercise the real backend, embedded Admin, storefront,
PostgreSQL, protected storage, checkout, automatic subscriber fulfillment,
entitlement, download, license, guest, refund, cancellation, and retry paths.
The exact tarball is installed into both backend and storefront workspaces. A
fixture-only Next.js route imports the package's public `./storefront` export,
calls the live product API through its client, and renders its attribution
component, so the storefront build/runtime check is a real package-consumer
test rather than a generic starter smoke test.

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
- logs, PIDs, receipts, and redacted evidence are written below the fixture's
  private `runtime/` directory, while raw guest capabilities use short-lived
  mode-0600 files that are deleted immediately after use.

Run local storage and S3-compatible storage as separate release gates:

```bash
export E2E_FIXTURE_ROOT=/absolute/path/to/marked-disposable-fixture

scripts/e2e/run-packed-e2e.sh \
  --tarball /absolute/path/to/makecrypto-medusa-plugin-digital-downloads-0.3.1.tgz \
  --storage local

scripts/e2e/run-packed-e2e.sh \
  --tarball /absolute/path/to/makecrypto-medusa-plugin-digital-downloads-0.3.1.tgz \
  --storage s3
```

Use `--keep-running` only when a subsequent browser test needs the same seeded
run. The runner prints the private run directory; stop those recorded processes
with the same fixture-root environment:

```bash
scripts/e2e/stop-fixture.sh /absolute/path/to/fixture/runtime/run-id
```

`--skip-storefront` is available for a backend-only diagnostic run, but it does
not satisfy the complete v1 release gate.

The scripts never pack the working tree themselves. Passing the exact tarball
that will be released ensures migrations, backend and storefront package
exports, compiled Admin extensions, and runtime dependencies are tested as
consumers receive them. In S3 mode the setup also applies and verifies a narrow
loopback-only CORS policy for direct browser uploads while retaining a private,
policy-free bucket.
