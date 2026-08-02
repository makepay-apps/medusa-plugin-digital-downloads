# Digital Downloads Admin extension

This directory contains the plugin's native Medusa Admin experience: the
Digital Downloads sidebar route, list/detail/create screens, settings and
reporting views, plus product and order detail widgets. All data access goes
through the authenticated `/admin/digital-downloads/*` API and TanStack Query.

Keep Admin projections secret-free. Storage credentials, raw object keys,
license ciphertext, bearer capabilities, and customer fingerprints must never
be rendered or cached. The merchant guide is in
[`docs/ADMIN_GUIDE.md`](../../docs/ADMIN_GUIDE.md).
