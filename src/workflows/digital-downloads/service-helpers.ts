import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../modules/digital-downloads"
import type { UnknownRecord } from "./types"
import { stripManagedFields } from "./utils"

export function resolveDigitalDownloadsService(container: MedusaContainer): any {
  return container.resolve(DIGITAL_DOWNLOADS_MODULE)
}

export async function retrieveDigitalProduct(
  service: any,
  id: string,
  withRelations = false
): Promise<UnknownRecord> {
  const config = withRelations
    ? { relations: ["releases", "releases.assets", "license_policy"] }
    : undefined

  if (typeof service.retrieveDigitalProductConfig === "function") {
    return service.retrieveDigitalProductConfig(id, config)
  }

  return service.retrieveDigitalProduct(id, config)
}

export async function createDigitalProduct(
  service: any,
  data: UnknownRecord
): Promise<UnknownRecord> {
  if (typeof service.createDigitalProductConfigs === "function") {
    return service.createDigitalProductConfigs(data)
  }

  return service.createDigitalProducts(data)
}

export async function updateDigitalProduct(
  service: any,
  data: UnknownRecord
): Promise<UnknownRecord> {
  if (typeof service.updateDigitalProductConfigs === "function") {
    return service.updateDigitalProductConfigs(data)
  }

  return service.updateDigitalProducts(data)
}

export async function deleteDigitalProduct(
  service: any,
  id: string
): Promise<void> {
  if (typeof service.deleteDigitalProductConfigs === "function") {
    await service.deleteDigitalProductConfigs(id)
    return
  }

  await service.deleteDigitalProducts(id)
}

export function digitalProductLinkDefinition(
  variantId: string,
  digitalProductId: string
): UnknownRecord {
  return {
    [Modules.PRODUCT]: { product_variant_id: variantId },
    [DIGITAL_DOWNLOADS_MODULE]: { digital_product_id: digitalProductId },
  }
}

export function orderEntitlementLinkDefinition(
  orderId: string,
  entitlementId: string
): UnknownRecord {
  return {
    [Modules.ORDER]: { order_id: orderId },
    [DIGITAL_DOWNLOADS_MODULE]: {
      digital_entitlement_id: entitlementId,
    },
  }
}

export function customerEntitlementLinkDefinition(
  customerId: string,
  entitlementId: string
): UnknownRecord {
  return {
    [Modules.CUSTOMER]: { customer_id: customerId },
    [DIGITAL_DOWNLOADS_MODULE]: {
      digital_entitlement_id: entitlementId,
    },
  }
}

export function getLinkService(
  container: MedusaContainer,
  leftModule: string,
  leftField: string,
  rightField: string
): any {
  const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
  return remoteLink.getLinkModule(
    leftModule,
    leftField,
    DIGITAL_DOWNLOADS_MODULE,
    rightField
  )
}

export async function restoreDigitalProductTree(
  service: any,
  snapshot: UnknownRecord
): Promise<void> {
  const releases = Array.isArray(snapshot.releases) ? snapshot.releases : []
  const licensePolicy = snapshot.license_policy

  await createDigitalProduct(service, stripManagedFields(snapshot, { keepId: true }))

  for (const release of releases) {
    const assets = Array.isArray(release.assets) ? release.assets : []
    await service.createDigitalProductReleases(
      stripManagedFields(release, { keepId: true })
    )

    for (const asset of assets) {
      await service.createDigitalAssets(
        stripManagedFields(asset, { keepId: true })
      )
    }
  }

  if (licensePolicy) {
    await service.createLicensePolicies(
      stripManagedFields(licensePolicy, { keepId: true })
    )
  }
}

export async function ensureOrderAndCustomerLinks(
  container: MedusaContainer,
  entitlements: UnknownRecord[]
): Promise<void> {
  if (!entitlements.length) {
    return
  }

  const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
  const orderLinkService = getLinkService(
    container,
    Modules.ORDER,
    "order_id",
    "digital_entitlement_id"
  )
  const customerLinkService = getLinkService(
    container,
    Modules.CUSTOMER,
    "customer_id",
    "digital_entitlement_id"
  )

  const orderIds = [...new Set(entitlements.map((entry) => entry.order_id).filter(Boolean))]
  const customerIds = [
    ...new Set(entitlements.map((entry) => entry.customer_id).filter(Boolean)),
  ]
  const entitlementIds = entitlements.map((entry) => entry.id)

  const existingOrderLinks = orderIds.length
    ? await orderLinkService.list(
        {
          order_id: orderIds,
          digital_entitlement_id: entitlementIds,
        },
        { take: Math.max(100, entitlementIds.length * 2) }
      )
    : []
  const existingCustomerLinks = customerIds.length
    ? await customerLinkService.list(
        {
          customer_id: customerIds,
          digital_entitlement_id: entitlementIds,
        },
        { take: Math.max(100, entitlementIds.length * 2) }
      )
    : []

  const orderLinked = new Set(
    existingOrderLinks.map(
      (entry: UnknownRecord) => `${entry.order_id}:${entry.digital_entitlement_id}`
    )
  )
  const customerLinked = new Set(
    existingCustomerLinks.map(
      (entry: UnknownRecord) =>
        `${entry.customer_id}:${entry.digital_entitlement_id}`
    )
  )
  const definitions: UnknownRecord[] = []

  for (const entitlement of entitlements) {
    const orderKey = `${entitlement.order_id}:${entitlement.id}`
    if (entitlement.order_id && !orderLinked.has(orderKey)) {
      definitions.push(
        orderEntitlementLinkDefinition(entitlement.order_id, entitlement.id)
      )
    }

    const customerKey = `${entitlement.customer_id}:${entitlement.id}`
    if (entitlement.customer_id && !customerLinked.has(customerKey)) {
      definitions.push(
        customerEntitlementLinkDefinition(entitlement.customer_id, entitlement.id)
      )
    }
  }

  if (definitions.length) {
    await remoteLink.create(definitions)
  }
}
