# Medusa module links

The plugin defines three native links:

- Product Variant → Digital Product
- Order → Digital Entitlement
- Customer → Digital Entitlement

They enable normal Medusa query-graph projections without duplicating commerce
records in the plugin module. A consuming Medusa application creates and syncs
the links with `npx medusa db:migrate` after installing or upgrading the
plugin.
