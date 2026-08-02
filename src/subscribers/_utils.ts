/* eslint-disable @medusajs/subscriber-config-export-required, @medusajs/subscriber-default-export-required -- underscore-prefixed helper files are excluded by Medusa's resource loader */
import type { Event, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type {
  ResolvedDigitalDownloadsModuleOptions,
  RevocationPolicy,
} from "../modules/digital-downloads/types"

export function eventTransactionId(
  prefix: string,
  event: Event<Record<string, any>>,
  fallbackId: string
): string {
  const timestamp = event.metadata?.created_at
    ? new Date(event.metadata.created_at).getTime()
    : 0
  return `${prefix}:${fallbackId}:${timestamp || "stable"}`
}

export async function orderIdForPayment(
  container: MedusaContainer,
  paymentId: string
): Promise<string | undefined> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const result = await query.graph({
    entity: "payments",
    fields: ["id", "payment_collection.order.id"],
    filters: { id: paymentId },
  })
  return result.data?.[0]?.payment_collection?.order?.id
}

export function subscriberRevocationPolicies(
  container: MedusaContainer,
  pluginOptions?: Record<string, any>
): { refundPolicy: RevocationPolicy; cancellationPolicy: RevocationPolicy } {
  try {
    const resolved = container.resolve(
      "digitalDownloadsOptions"
    ) as ResolvedDigitalDownloadsModuleOptions
    if (resolved?.refundPolicy && resolved?.cancellationPolicy) {
      return {
        refundPolicy: resolved.refundPolicy,
        cancellationPolicy: resolved.cancellationPolicy,
      }
    }
  } catch {
    // Some isolated subscriber tests do not run module loaders.
  }

  const nested =
    pluginOptions?.digitalDownloads ??
    pluginOptions?.digital_downloads ??
    pluginOptions ??
    {}
  return {
    refundPolicy:
      nested.refundPolicy ?? nested.refund_policy ?? "full_refund",
    cancellationPolicy:
      nested.cancellationPolicy ?? nested.cancellation_policy ?? "all",
  }
}
