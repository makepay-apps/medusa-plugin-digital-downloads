# Security policy

## Supported versions

Security fixes are provided for the latest release. Keep Medusa, Node.js,
PostgreSQL, and the selected object-storage service on supported versions.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security-advisory flow for this repository and include reproduction steps,
affected routes or models, impact, and any suggested remediation. Maintainers
will acknowledge a report within five business days.

Never include production license keys, download tokens, storage credentials,
customer data, or MakePay credentials in a report.

## Security assumptions

- Master assets must remain private. Public previews are deliberately public.
- `encryptionKey` must be a dedicated 32-byte secret represented as 64 hex
  characters, must differ from `tokenSecret`, and must remain stable for as
  long as encrypted licenses exist. Generate both secrets independently.
- S3 credentials should be restricted to the configured bucket and prefix.
- Local storage must be on persistent disk outside a publicly served directory.
- The application must run behind a trusted proxy configuration before IP-based
  download locking is enabled.
- Storefront clients must treat download URLs and guest access tokens as bearer
  credentials and must not log or cache them.
