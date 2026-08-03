"use client"

import type { ReactNode } from "react"
import { DigitalDownloadsError } from "../errors"
import type { DigitalLibraryQuery } from "../types"
import {
  DigitalLibrary,
  type DigitalLibraryProps,
} from "./digital-library"

export type DigitalOrderDownloadsQuery = Omit<DigitalLibraryQuery, "order_id">

export interface DigitalOrderDownloadsProps
  extends Omit<
    DigitalLibraryProps,
    "empty" | "heading" | "orderReference" | "query"
  > {
  /** Medusa order ID used to scope the customer-owned library request. */
  orderId: string
  /** Medusa's buyer-facing display ID, usually the numeric order number. */
  orderDisplayId?: string | number | null
  /** Additional library filters; `order_id` is always enforced from orderId. */
  query?: DigitalOrderDownloadsQuery
  heading?: ReactNode
  empty?: ReactNode
}

const buyerOrderReference = (
  orderId: string,
  displayId?: string | number | null
): string => {
  if (typeof displayId === "number" && Number.isFinite(displayId)) {
    return `#${displayId}`
  }

  if (typeof displayId === "string" && displayId.trim()) {
    const normalized = displayId.trim()
    return /^\d+$/.test(normalized) ? `#${normalized}` : normalized
  }

  return orderId
}

/**
 * Customer-owned digital delivery for one native Medusa order-detail page.
 * The order scope cannot be overridden through the optional query filters.
 */
export const DigitalOrderDownloads = ({
  orderId,
  orderDisplayId,
  query,
  heading,
  empty = "This order has no digital downloads or licenses.",
  ...libraryProps
}: DigitalOrderDownloadsProps) => {
  const normalizedOrderId =
    typeof orderId === "string" ? orderId.trim() : ""
  if (!normalizedOrderId) {
    throw new DigitalDownloadsError("orderId is required for an order library.", {
      code: "invalid_argument",
    })
  }

  const orderReference = buyerOrderReference(normalizedOrderId, orderDisplayId)

  return (
    <DigitalLibrary
      {...libraryProps}
      empty={empty}
      heading={
        heading ?? `Downloads & licenses for order ${orderReference}`
      }
      orderReference={orderReference}
      query={{ ...query, order_id: normalizedOrderId }}
    />
  )
}
