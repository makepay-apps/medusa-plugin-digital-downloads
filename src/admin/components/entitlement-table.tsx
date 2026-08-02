import { Button, Checkbox, Table, Text } from "@medusajs/ui"

import { formatDate } from "../lib/format"
import type {
  DigitalEntitlement,
  PaginatedResponse,
} from "../types/digital-downloads"
import { DigitalStatusBadge } from "./status-badge"

interface EntitlementTableProps {
  data: PaginatedResponse<DigitalEntitlement>
  selected: Set<string>
  pageIndex: number
  pageSize: number
  isMutating?: boolean
  onPageChange: (page: number) => void
  onSelectionChange: (selected: Set<string>) => void
  onReissue?: (id: string) => void
}

export const EntitlementTable = ({
  data,
  selected,
  pageIndex,
  pageSize,
  isMutating,
  onPageChange,
  onSelectionChange,
  onReissue,
}: EntitlementTableProps) => {
  const revocableIds = data.items
    .filter((item) => item.status !== "revoked")
    .map((item) => item.id)
  const allSelected = Boolean(revocableIds.length) && revocableIds.every((id) => selected.has(id))
  const someSelected = revocableIds.some((id) => selected.has(id))
  const pageCount = Math.max(1, Math.ceil(data.count / pageSize))

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell className="w-10">
                <Checkbox
                  aria-label="Select all revocable entitlements"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected)
                    revocableIds.forEach((id) =>
                      checked === true ? next.add(id) : next.delete(id)
                    )
                    onSelectionChange(next)
                  }}
                />
              </Table.HeaderCell>
              <Table.HeaderCell>Order / customer</Table.HeaderCell>
              <Table.HeaderCell>Item</Table.HeaderCell>
              <Table.HeaderCell>Downloads</Table.HeaderCell>
              <Table.HeaderCell>License</Table.HeaderCell>
              <Table.HeaderCell>Expires</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.items.map((entitlement) => {
              const count = entitlement.downloads?.count ?? entitlement.download_count ?? 0
              const limit = entitlement.downloads?.limit ?? entitlement.download_limit
              return (
                <Table.Row key={entitlement.id}>
                  <Table.Cell>
                    <Checkbox
                      aria-label={`Select entitlement ${entitlement.id}`}
                      checked={selected.has(entitlement.id)}
                      disabled={entitlement.status === "revoked"}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected)
                        checked === true
                          ? next.add(entitlement.id)
                          : next.delete(entitlement.id)
                        onSelectionChange(next)
                      }}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" weight="plus">
                      {entitlement.order_id}
                    </Text>
                    <Text className="text-ui-fg-muted" size="xsmall">
                      {entitlement.customer_email || entitlement.customer_id || "Guest"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {entitlement.line_item_title || entitlement.product_title || "Digital item"}
                    </Text>
                    <Text className="text-ui-fg-muted" size="xsmall">
                      {entitlement.variant_title || entitlement.variant_id || "—"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {count} / {limit ?? "∞"}
                  </Table.Cell>
                  <Table.Cell>
                    <span className="font-mono txt-compact-xsmall">
                      {entitlement.license_key_masked ||
                        entitlement.licenses?.[0]?.masked_key ||
                        entitlement.licenses?.[0]?.key_hint ||
                        "—"}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{formatDate(entitlement.expires_at)}</Table.Cell>
                  <Table.Cell>
                    <DigitalStatusBadge status={entitlement.status} />
                  </Table.Cell>
                  <Table.Cell>
                    {onReissue &&
                    (entitlement.status === "revoked" || entitlement.status === "expired") ? (
                      <Button
                        disabled={isMutating}
                        onClick={() => onReissue(entitlement.id)}
                        size="small"
                        variant="transparent"
                      >
                        Reissue
                      </Button>
                    ) : null}
                  </Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table>
      </div>
      <Table.Pagination
        canNextPage={pageIndex + 1 < pageCount}
        canPreviousPage={pageIndex > 0}
        count={data.count}
        nextPage={() => onPageChange(pageIndex + 1)}
        pageCount={pageCount}
        pageIndex={pageIndex}
        pageSize={pageSize}
        previousPage={() => onPageChange(pageIndex - 1)}
      />
    </>
  )
}
