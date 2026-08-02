import { StatusBadge } from "@medusajs/ui"

import { humanize } from "../lib/format"

type BadgeColor = "green" | "red" | "blue" | "orange" | "grey" | "purple"

const colorByStatus: Record<string, BadgeColor> = {
  active: "green",
  published: "green",
  ready: "green",
  complete: "green",
  fulfilled: "green",
  draft: "grey",
  inactive: "grey",
  archived: "grey",
  retired: "grey",
  pending: "orange",
  uploading: "blue",
  processing: "blue",
  stream: "purple",
  exhausted: "orange",
  expired: "orange",
  suspended: "orange",
  revoked: "red",
  refunded: "red",
  failed: "red",
  quarantined: "red",
}

export const DigitalStatusBadge = ({ status }: { status?: string | null }) => (
  <StatusBadge color={colorByStatus[status ?? ""] ?? "grey"}>
    {humanize(status)}
  </StatusBadge>
)
