import {
  acquireLockStep,
  emitEventStep,
  releaseLockStep,
} from "@medusajs/medusa/core-flows"
import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../modules/digital-downloads"
import {
  isFulfillmentStrategy,
  PRODUCT_CONFIG_RESERVED_METADATA_FIELDS,
  stripReservedProductConfigMetadata,
} from "../../product-config-metadata"
import { DIGITAL_DOWNLOAD_EVENTS } from "./events"
import {
  createDigitalProduct,
  deleteDigitalProduct,
  digitalProductLinkDefinition,
  getLinkService,
  resolveDigitalDownloadsService,
  restoreDigitalProductTree,
  retrieveDigitalProduct,
  updateDigitalProduct,
} from "./service-helpers"
import type {
  CreateDigitalProductReleaseWorkflowInput,
  CreateDigitalProductWorkflowInput,
  DeleteDigitalProductReleaseWorkflowInput,
  DeleteDigitalProductWorkflowInput,
  PublishDigitalProductReleaseWorkflowInput,
  UnknownRecord,
  UpdateDigitalProductReleaseWorkflowInput,
  UpdateDigitalProductWorkflowInput,
} from "./types"
import { requireIdentifier, stripManagedFields } from "./utils"

function variantIdsFromInput(input: UnknownRecord): string[] {
  const values: unknown[] =
    input.variant_ids ??
    input.variantIds ??
    (input.variant_id ? [input.variant_id] : undefined) ??
    (input.variantId ? [input.variantId] : undefined) ??
    []
  return [
    ...new Set(
      values.filter(
        (value: unknown): value is string =>
          typeof value === "string" && Boolean(value)
      )
    ),
  ]
}

async function validateVariants(
  container: any,
  variantIds: string[],
  requestedProductId?: string
): Promise<{ product_id: string; variant_ids: string[] }> {
  if (!variantIds.length || variantIds.length > 100) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Between 1 and 100 product variants are required"
    )
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const result = await query.graph({
    entity: "product_variant",
    fields: ["id", "product_id", "product.id"],
    filters: { id: variantIds },
  })
  const variants = result.data ?? []
  const foundIds = new Set(variants.map((variant: UnknownRecord) => variant.id))
  const missing = variantIds.filter((id) => !foundIds.has(id))
  if (missing.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Product variants were not found: ${missing.join(", ")}`
    )
  }
  const productIds = new Set(
    variants
      .map(
        (variant: UnknownRecord) => variant.product_id ?? variant.product?.id
      )
      .filter(Boolean)
  )
  if (productIds.size !== 1) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "All digital product variants must belong to one Medusa product"
    )
  }
  const productId = [...productIds][0] as string
  if (requestedProductId && requestedProductId !== productId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "variant_ids must belong to product_id"
    )
  }
  return { product_id: productId, variant_ids: variantIds }
}

const CONFIG_METADATA_FIELDS = PRODUCT_CONFIG_RESERVED_METADATA_FIELDS.filter(
  (field) => field !== "medusa_product_id" && field !== "variant_ids" &&
    field !== "max_downloads" && field !== "access_duration_seconds" &&
    field !== "access_duration_days"
)

function persistencePayload(
  source: UnknownRecord,
  linkData: { product_id: string; variant_ids: string[] },
  previous?: UnknownRecord
): UnknownRecord {
  const allowed = [
    "title",
    "handle",
    "description",
    "status",
    "delivery_type",
    "fulfillment_required",
    "published_at",
  ]
  const result: UnknownRecord = {}
  for (const field of allowed) {
    if (source[field] !== undefined) {
      result[field] = source[field]
    }
  }
  const metadata: UnknownRecord = {
    ...(previous?.metadata ?? {}),
    ...stripReservedProductConfigMetadata(source.metadata),
    medusa_product_id: linkData.product_id,
    variant_ids: linkData.variant_ids,
  }
  for (const field of CONFIG_METADATA_FIELDS) {
    if (
      field === "fulfillment_strategy" &&
      !isFulfillmentStrategy(source[field])
    ) {
      continue
    }
    if (source[field] !== undefined) {
      metadata[field] = source[field]
    }
  }
  result.metadata = metadata
  return result
}

function payloadFromInput(
  input: UnknownRecord,
  nestedFields: string[],
  omittedFields: string[]
): UnknownRecord {
  for (const field of nestedFields) {
    if (input[field] && typeof input[field] === "object") {
      return { ...input[field] }
    }
  }

  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !omittedFields.includes(key))
  )
}

const MAX_RELEASE_ASSETS = 200

type AssetReleaseAssignment = {
  id: string
  release_id: string | null
}

function assetReleaseId(asset: UnknownRecord): string | null {
  return asset.release_id ?? asset.release?.id ?? null
}

function assetIdsFromReleaseInput(input: UnknownRecord): string[] | undefined {
  const value =
    input.asset_ids ??
    input.assetIds ??
    input.data?.asset_ids ??
    input.data?.assetIds ??
    input.release?.asset_ids ??
    input.release?.assetIds

  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_RELEASE_ASSETS) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `asset_ids must contain at most ${MAX_RELEASE_ASSETS} asset IDs`
    )
  }
  if (
    value.some(
      (id) => typeof id !== "string" || !id.trim() || /[\r\n\0]/.test(id)
    )
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "asset_ids must contain non-empty safe strings"
    )
  }

  const normalized = value.map((id) => id.trim())
  if (new Set(normalized).size !== normalized.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "asset_ids must not contain duplicate IDs"
    )
  }
  return normalized
}

function releasePersistencePayload(
  input: UnknownRecord,
  nestedFields: string[],
  omittedFields: string[]
): UnknownRecord {
  const data = payloadFromInput(input, nestedFields, [
    ...omittedFields,
    "asset_ids",
    "assetIds",
  ])
  delete data.asset_ids
  delete data.assetIds
  return data
}

async function retrieveAssetsByIds(
  service: any,
  assetIds: string[]
): Promise<UnknownRecord[]> {
  if (!assetIds.length) {
    return []
  }
  const assets = await service.listDigitalAssets(
    { id: assetIds },
    { relations: ["release"], take: MAX_RELEASE_ASSETS }
  )
  const found = new Set(assets.map((asset: UnknownRecord) => asset.id))
  const missing = assetIds.filter((id) => !found.has(id))
  if (missing.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Digital assets were not found: ${missing.join(", ")}`
    )
  }
  const byId = new Map(
    assets.map((asset: UnknownRecord) => [asset.id, asset])
  )
  return assetIds.map((id) => byId.get(id) as UnknownRecord)
}

async function assertAssetsCanMove(
  service: any,
  assets: UnknownRecord[],
  targetReleaseId?: string
): Promise<void> {
  const moving = assets.filter(
    (asset) =>
      assetReleaseId(asset) &&
      (!targetReleaseId || assetReleaseId(asset) !== targetReleaseId)
  )
  if (!moving.length) {
    return
  }

  const sourceReleaseIds = [
    ...new Set(moving.map(assetReleaseId).filter(Boolean)),
  ] as string[]
  const sourceReleases = await service.listDigitalProductReleases(
    { id: sourceReleaseIds },
    { take: sourceReleaseIds.length }
  )
  const published = sourceReleases.find(
    (release: UnknownRecord) =>
      String(release.status).toLowerCase() === "published"
  )
  if (published) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      `Assets cannot be reassigned from published release ${published.id}`
    )
  }

  const referencedEntitlements = await service.listDigitalEntitlements(
    { release_id: sourceReleaseIds },
    { take: 1 }
  )
  if (referencedEntitlements.length) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "Assets referenced by an entitlement purchase snapshot cannot be reassigned"
    )
  }

  const grants = await service.listDownloadGrants(
    { asset_id: moving.map((asset) => asset.id) },
    { take: 1 }
  )
  if (grants.length) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "Assets with issued download grants cannot be reassigned"
    )
  }
}

async function assertReleaseAssetsCanBeRemoved(
  service: any,
  release: UnknownRecord,
  assets: UnknownRecord[]
): Promise<void> {
  if (!assets.length) {
    return
  }
  if (String(release.status).toLowerCase() === "published") {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "The asset set of a published release is immutable"
    )
  }
  const referencedEntitlements = await service.listDigitalEntitlements(
    { release_id: release.id },
    { take: 1 }
  )
  if (referencedEntitlements.length) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "Assets referenced by an entitlement purchase snapshot cannot be removed"
    )
  }
  const grants = await service.listDownloadGrants(
    { asset_id: assets.map((asset) => asset.id) },
    { take: 1 }
  )
  if (grants.length) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "Assets with issued download grants cannot be removed"
    )
  }
}

async function restoreAssetAssignments(
  service: any,
  assignments: AssetReleaseAssignment[]
): Promise<void> {
  if (!assignments.length) {
    return
  }
  await service.updateDigitalAssets(assignments)
}

type CreateDigitalProductStepOutput = {
  digital_product: UnknownRecord
  product_id: string
  variant_ids: string[]
  created: boolean
}

type CreateDigitalProductStepRollback = {
  id: string | null
  link_definitions: UnknownRecord[]
}

const createDigitalProductStep = createStep<
  CreateDigitalProductWorkflowInput,
  CreateDigitalProductStepOutput,
  CreateDigitalProductStepRollback
>(
  "create-digital-product",
  async (input: CreateDigitalProductWorkflowInput, { container }) => {
    const requestedVariantIds = variantIdsFromInput(input)
    const linkData = await validateVariants(
      container,
      requestedVariantIds,
      input.product_id ?? input.productId
    )
    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const linkService = getLinkService(
      container,
      Modules.PRODUCT,
      "product_variant_id",
      "digital_product_id"
    )
    const existingLinks = await linkService.list(
      { product_variant_id: linkData.variant_ids },
      { take: 100 }
    )

    if (existingLinks.length) {
      const existingProductIds = new Set(
        existingLinks.map((entry: UnknownRecord) => entry.digital_product_id)
      )
      if (
        existingProductIds.size === 1 &&
        existingLinks.length === linkData.variant_ids.length
      ) {
        const existing = await retrieveDigitalProduct(
          service,
          [...existingProductIds][0] as string
        )
        const projection = {
          ...existing,
          product_id: linkData.product_id,
          variant_ids: linkData.variant_ids,
        }
        return new StepResponse(
          {
            digital_product: projection,
            product_id: linkData.product_id,
            variant_ids: linkData.variant_ids,
            created: false,
          },
          { id: null, link_definitions: [] } as CreateDigitalProductStepRollback
        )
      }
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        "One or more variants already have another digital product configuration"
      )
    }

    const data = payloadFromInput(
      input,
      ["data", "product"],
      [
        "variant_id",
        "variantId",
        "variant_ids",
        "variantIds",
        "product_id",
        "productId",
      ]
    )
    const created = await createDigitalProduct(
      service,
      persistencePayload(data, linkData)
    )
    const linkDefinitions = linkData.variant_ids.map((variantId) =>
      digitalProductLinkDefinition(variantId, created.id)
    )

    try {
      await remoteLink.create(linkDefinitions)
    } catch (error) {
      await deleteDigitalProduct(service, created.id).catch(() => undefined)
      throw error
    }

    return new StepResponse(
      {
        digital_product: {
          ...created,
          product_id: linkData.product_id,
          variant_ids: linkData.variant_ids,
        },
        product_id: linkData.product_id,
        variant_ids: linkData.variant_ids,
        created: true,
      },
      {
        id: created.id,
        link_definitions: linkDefinitions,
      } as CreateDigitalProductStepRollback
    )
  },
  async (rollback, { container }) => {
    if (!rollback?.id) {
      return
    }

    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const service = resolveDigitalDownloadsService(container)
    if (rollback.link_definitions.length) {
      await remoteLink.dismiss(rollback.link_definitions).catch(() => undefined)
    }
    await deleteDigitalProduct(service, rollback.id).catch(() => undefined)
  }
)

const updateDigitalProductStep = createStep(
  "update-digital-product",
  async (input: UpdateDigitalProductWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const linkService = getLinkService(
      container,
      Modules.PRODUCT,
      "product_variant_id",
      "digital_product_id"
    )
    const previous = await retrieveDigitalProduct(service, input.id)
    const previousLinks = await linkService.list(
      { digital_product_id: input.id },
      { take: 100 }
    )
    const previousVariantIds = previousLinks.map(
      (entry: UnknownRecord) => entry.product_variant_id
    )
    const raw = input.data
      ? { ...input, ...input.data }
      : { ...input }
    const requestedVariantIds = variantIdsFromInput(raw)
    const desiredVariantIds = requestedVariantIds.length
      ? requestedVariantIds
      : previousVariantIds
    const linkData = await validateVariants(
      container,
      desiredVariantIds,
      raw.product_id ?? raw.productId ?? previous.metadata?.medusa_product_id
    )
    const desiredSet = new Set(linkData.variant_ids)
    const previousSet = new Set(previousVariantIds)
    const added = linkData.variant_ids.filter((id) => !previousSet.has(id))
    const removed = previousVariantIds.filter((id: string) => !desiredSet.has(id))
    if (added.length) {
      const conflicts = await linkService.list(
        { product_variant_id: added },
        { take: 100 }
      )
      if (conflicts.some((entry: UnknownRecord) => entry.digital_product_id !== input.id)) {
        throw new MedusaError(
          MedusaError.Types.CONFLICT,
          "One or more variants already have another digital product configuration"
        )
      }
    }
    const addedDefinitions = added.map((id) =>
      digitalProductLinkDefinition(id, input.id)
    )
    const removedDefinitions = removed.map((id: string) =>
      digitalProductLinkDefinition(id, input.id)
    )
    if (addedDefinitions.length) {
      await remoteLink.create(addedDefinitions)
    }
    if (removedDefinitions.length) {
      await remoteLink.dismiss(removedDefinitions)
    }
    const data = persistencePayload(raw, linkData, previous)
    const updated = await updateDigitalProduct(service, { id: input.id, ...data })
    return new StepResponse(
      {
        ...updated,
        product_id: linkData.product_id,
        variant_ids: linkData.variant_ids,
      },
      {
        previous,
        added_definitions: addedDefinitions,
        removed_definitions: removedDefinitions,
      }
    )
  },
  async (rollback, { container }) => {
    if (!rollback?.previous?.id) {
      return
    }

    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    await updateDigitalProduct(service, {
      id: rollback.previous.id,
      ...stripManagedFields(rollback.previous),
    })
    if (rollback.added_definitions?.length) {
      await remoteLink.dismiss(rollback.added_definitions)
    }
    if (rollback.removed_definitions?.length) {
      await remoteLink.create(rollback.removed_definitions)
    }
  }
)

const deleteDigitalProductStep = createStep(
  "delete-digital-product",
  async (input: DeleteDigitalProductWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const linkService = getLinkService(
      container,
      Modules.PRODUCT,
      "product_variant_id",
      "digital_product_id"
    )
    const snapshot = await retrieveDigitalProduct(service, input.id, true)
    const links = await linkService.list(
      { digital_product_id: input.id },
      { take: 100 }
    )
    const definitions = links.map((entry: UnknownRecord) =>
      digitalProductLinkDefinition(entry.product_variant_id, input.id)
    )

    if (definitions.length) {
      await remoteLink.dismiss(definitions)
    }
    await deleteDigitalProduct(service, input.id)

    return new StepResponse(
      { id: input.id, deleted: true },
      { snapshot, link_definitions: definitions }
    )
  },
  async (rollback, { container }) => {
    if (!rollback?.snapshot) {
      return
    }

    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    await restoreDigitalProductTree(service, rollback.snapshot)
    if (rollback.link_definitions?.length) {
      await remoteLink.create(rollback.link_definitions)
    }
  }
)

const createDigitalProductReleaseStep = createStep(
  "create-digital-product-release",
  async (input: CreateDigitalProductReleaseWorkflowInput, { container }) => {
    const digitalProductId = requireIdentifier(
      input,
      "digital_product_id",
      "digitalProductId"
    )
    const service = resolveDigitalDownloadsService(container)
    const data = releasePersistencePayload(
      input,
      ["data", "release"],
      ["digital_product_id", "digitalProductId"]
    )
    const assetIds = assetIdsFromReleaseInput(input) ?? []
    const assets = await retrieveAssetsByIds(service, assetIds)
    await assertAssetsCanMove(service, assets)
    const release = await service.createDigitalProductReleases({
      ...data,
      digital_product_id: digitalProductId,
    })
    const previousAssignments = assets.map((asset) => ({
      id: asset.id,
      release_id: assetReleaseId(asset),
    }))

    try {
      if (assets.length) {
        await service.updateDigitalAssets(
          assets.map((asset) => ({ id: asset.id, release_id: release.id }))
        )
      }
      const result = await service.retrieveDigitalProductRelease(release.id, {
        relations: ["assets"],
      })
      return new StepResponse(result, {
        id: release.id,
        previous_assignments: previousAssignments,
      })
    } catch (error) {
      await restoreAssetAssignments(service, previousAssignments).catch(
        () => undefined
      )
      await service.deleteDigitalProductReleases(release.id).catch(
        () => undefined
      )
      throw error
    }
  },
  async (rollback, { container }) => {
    if (rollback?.id) {
      const service = resolveDigitalDownloadsService(container)
      await restoreAssetAssignments(
        service,
        rollback.previous_assignments ?? []
      )
      await service.deleteDigitalProductReleases(rollback.id)
    }
  }
)

const updateDigitalProductReleaseStep = createStep(
  "update-digital-product-release",
  async (input: UpdateDigitalProductReleaseWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const previous = await service.retrieveDigitalProductRelease(input.id, {
      relations: ["assets"],
    })
    const data = releasePersistencePayload(input, ["data"], ["id"])
    const requestedAssetIds = assetIdsFromReleaseInput(input)
    const currentAssets = Array.isArray(previous.assets)
      ? previous.assets
      : await service.listDigitalAssets(
          { release_id: input.id },
          { relations: ["release"], take: MAX_RELEASE_ASSETS + 1 }
        )
    if (currentAssets.length > MAX_RELEASE_ASSETS) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `A release cannot contain more than ${MAX_RELEASE_ASSETS} assets`
      )
    }

    const desiredAssets =
      requestedAssetIds === undefined
        ? currentAssets
        : await retrieveAssetsByIds(service, requestedAssetIds)
    const desiredIds = new Set(desiredAssets.map((asset) => asset.id))
    const addedAssets = desiredAssets.filter(
      (asset) => assetReleaseId(asset) !== input.id
    )
    const removedAssets =
      requestedAssetIds === undefined
        ? []
        : currentAssets.filter((asset: UnknownRecord) => !desiredIds.has(asset.id))

    if (
      (addedAssets.length || removedAssets.length) &&
      String(previous.status).toLowerCase() === "published"
    ) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        "The asset set of a published release is immutable"
      )
    }

    await assertAssetsCanMove(service, addedAssets, input.id)
    await assertReleaseAssetsCanBeRemoved(service, previous, removedAssets)

    const previousAssignments: AssetReleaseAssignment[] = [
      ...addedAssets.map((asset) => ({
        id: asset.id,
        release_id: assetReleaseId(asset),
      })),
      ...removedAssets.map((asset: UnknownRecord) => ({
        id: asset.id,
        release_id: input.id,
      })),
    ]
    const nextAssignments: AssetReleaseAssignment[] = [
      ...addedAssets.map((asset) => ({
        id: asset.id,
        release_id: input.id,
      })),
      ...removedAssets.map((asset: UnknownRecord) => ({
        id: asset.id,
        release_id: null,
      })),
    ]

    let releaseUpdated = false
    try {
      if (Object.keys(data).length) {
        await service.updateDigitalProductReleases({
          id: input.id,
          ...data,
        })
        releaseUpdated = true
      }
      await restoreAssetAssignments(service, nextAssignments)
      const result = await service.retrieveDigitalProductRelease(input.id, {
        relations: ["assets"],
      })
      return new StepResponse(result, {
        previous,
        previous_assignments: previousAssignments,
      })
    } catch (error) {
      await restoreAssetAssignments(service, previousAssignments).catch(
        () => undefined
      )
      if (releaseUpdated) {
        await service
          .updateDigitalProductReleases({
            id: previous.id,
            ...stripManagedFields(previous),
          })
          .catch(() => undefined)
      }
      throw error
    }
  },
  async (rollback, { container }) => {
    if (rollback?.previous?.id) {
      const service = resolveDigitalDownloadsService(container)
      await restoreAssetAssignments(
        service,
        rollback.previous_assignments ?? []
      )
      await service.updateDigitalProductReleases({
        id: rollback.previous.id,
        ...stripManagedFields(rollback.previous),
      })
    }
  }
)

const resolveReleaseProductForPublishStep = createStep(
  "resolve-release-product-for-publish",
  async (input: PublishDigitalProductReleaseWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const release = await service.retrieveDigitalProductRelease(input.id)
    if (!release.digital_product_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Release ${input.id} is not linked to a digital product`
      )
    }
    return new StepResponse({
      release_id: release.id,
      digital_product_id: release.digital_product_id,
    })
  }
)

const publishDigitalProductReleaseStep = createStep(
  "publish-digital-product-release",
  async (input: PublishDigitalProductReleaseWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const result = await service.publishDigitalProductRelease(input.id, {
      make_active: input.make_active ?? input.makeActive ?? true,
      notify_existing_customers:
        input.notify_existing_customers ??
        input.notifyExistingCustomers ??
        false,
    })
    return new StepResponse(result)
  }
)

const deleteDigitalProductReleaseStep = createStep(
  "delete-digital-product-release",
  async (input: DeleteDigitalProductReleaseWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const snapshot = await service.retrieveDigitalProductRelease(input.id, {
      relations: ["assets"],
    })
    const entitlements = await service.listDigitalEntitlements(
      { release_id: input.id },
      { take: 1 }
    )
    if (
      String(snapshot.status).toLowerCase() === "published" ||
      entitlements.length
    ) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        "Published or purchased releases are immutable and cannot be deleted"
      )
    }
    await service.deleteDigitalProductReleases(input.id)
    return new StepResponse({ id: input.id, deleted: true }, snapshot)
  },
  async (snapshot, { container }) => {
    if (!snapshot?.id) {
      return
    }
    const service = resolveDigitalDownloadsService(container)
    await service.createDigitalProductReleases(
      stripManagedFields(snapshot, { keepId: true })
    )
    for (const asset of snapshot.assets ?? []) {
      await service.createDigitalAssets(
        stripManagedFields(asset, { keepId: true })
      )
    }
  }
)

export const createDigitalProductWorkflow = createWorkflow(
  { name: "digital-downloads-create-product", idempotent: true, store: true },
  (input: CreateDigitalProductWorkflowInput) => {
    const lockKey = transform(
      input,
      (data) => {
        const ids = variantIdsFromInput(data)
        return `digital-downloads:variant:${ids.sort().join(",") || "missing"}`
      }
    )
    acquireLockStep({ key: lockKey, ttl: 30, timeout: 10, executeOnSubWorkflow: true })
    const result = createDigitalProductStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.PRODUCT_CONFIG_CREATED,
      data: result,
    })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const updateDigitalProductWorkflow = createWorkflow(
  { name: "digital-downloads-update-product", idempotent: true, store: true },
  (input: UpdateDigitalProductWorkflowInput) => {
    const lockKey = transform(input, (data) => `digital-downloads:product:${data.id}`)
    acquireLockStep({ key: lockKey, ttl: 30, timeout: 10, executeOnSubWorkflow: true })
    const result = updateDigitalProductStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.PRODUCT_CONFIG_UPDATED,
      data: result,
    })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const deleteDigitalProductWorkflow = createWorkflow(
  { name: "digital-downloads-delete-product", idempotent: true, store: true },
  (input: DeleteDigitalProductWorkflowInput) => {
    const lockKey = transform(input, (data) => `digital-downloads:product:${data.id}`)
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = deleteDigitalProductStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.PRODUCT_CONFIG_DELETED,
      data: result,
    })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const createDigitalProductReleaseWorkflow = createWorkflow(
  { name: "digital-downloads-create-release", idempotent: true, store: true },
  (input: CreateDigitalProductReleaseWorkflowInput) => {
    const lockKey = transform(
      input,
      (data) =>
        `digital-downloads:product:${data.digital_product_id ?? data.digitalProductId ?? "missing"}:release`
    )
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = createDigitalProductReleaseStep(input)
    emitEventStep({ eventName: DIGITAL_DOWNLOAD_EVENTS.RELEASE_CREATED, data: result })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const updateDigitalProductReleaseWorkflow = createWorkflow(
  { name: "digital-downloads-update-release", idempotent: true, store: true },
  (input: UpdateDigitalProductReleaseWorkflowInput) => {
    const lockKey = transform(input, (data) => `digital-downloads:release:${data.id}`)
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = updateDigitalProductReleaseStep(input)
    emitEventStep({ eventName: DIGITAL_DOWNLOAD_EVENTS.RELEASE_UPDATED, data: result })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const publishDigitalProductReleaseWorkflow = createWorkflow(
  { name: "digital-downloads-publish-release", idempotent: true, store: true },
  (input: PublishDigitalProductReleaseWorkflowInput) => {
    const identity = resolveReleaseProductForPublishStep(input)
    const lockKey = transform(
      identity,
      (data) => `digital-downloads:product:${data.digital_product_id}:publish`
    )
    acquireLockStep({
      key: lockKey,
      ttl: 60,
      timeout: 10,
      executeOnSubWorkflow: true,
    })
    const result = publishDigitalProductReleaseStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.RELEASE_PUBLISHED,
      data: result,
    })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const deleteDigitalProductReleaseWorkflow = createWorkflow(
  { name: "digital-downloads-delete-release", idempotent: true, store: true },
  (input: DeleteDigitalProductReleaseWorkflowInput) => {
    const lockKey = transform(input, (data) => `digital-downloads:release:${data.id}`)
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = deleteDigitalProductReleaseStep(input)
    emitEventStep({ eventName: DIGITAL_DOWNLOAD_EVENTS.RELEASE_DELETED, data: result })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)
