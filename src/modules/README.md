# Digital Downloads module

`digital-downloads` is the plugin's isolated Medusa v2 module. Its service owns
product configurations, immutable releases and assets, upload intents,
entitlements and grants, license policies and activations, notification
delivery state, audit events, and local/S3 storage coordination.

The initial v1 migration and MikroORM snapshot live under
`digital-downloads/migrations`. Consumers apply them with:

```bash
npx medusa db:migrate
```

Storage topology and cryptographic secrets are runtime options; only policy,
non-secret fingerprints, and operational state are persisted. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the trust boundaries.
