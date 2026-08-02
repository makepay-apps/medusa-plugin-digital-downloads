import { Checkbox, Table, Text } from "@medusajs/ui"

import { formatDate, humanize } from "../lib/format"
import type { PaginatedResponse, ProductConfig } from "../types/digital-downloads"
import { DigitalStatusBadge } from "./status-badge"

interface ProductConfigTableProps {
  data: PaginatedResponse<ProductConfig>
  selected: Set<string>
  pageIndex: number
  pageSize: number
  onPageChange: (page: number) => void
  onRowClick: (id: string) => void
  onSelectionChange: (selected: Set<string>) => void
}

export const ProductConfigTable = ({
  data,
  selected,
  pageIndex,
  pageSize,
  onPageChange,
  onRowClick,
  onSelectionChange,
}: ProductConfigTableProps) => {
  const pageIds = data.items.map((item) => item.id)
  const allSelected = Boolean(pageIds.length) && pageIds.every((id) => selected.has(id))
  const someSelected = pageIds.some((id) => selected.has(id))
  const pageCount = Math.max(1, Math.ceil(data.count / pageSize))

  const togglePage = (checked: boolean) => {
    const next = new Set(selected)
    pageIds.forEach((id) => (checked ? next.add(id) : next.delete(id)))
    onSelectionChange(next)
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell className="w-10">
                <Checkbox
                  aria-label="Select all configurations on this page"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(checked) => togglePage(checked === true)}
                />
              </Table.HeaderCell>
              <Table.HeaderCell>Configuration</Table.HeaderCell>
              <Table.HeaderCell>Delivery</Table.HeaderCell>
              <Table.HeaderCell>Release</Table.HeaderCell>
              <Table.HeaderCell>Assets</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Updated</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.items.map((config) => (
              <Table.Row
                className="cursor-pointer"
                key={config.id}
                onClick={() => onRowClick(config.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onRowClick(config.id)
                  }
                }}
                tabIndex={0}
              >
                <Table.Cell onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select ${config.title}`}
                    checked={selected.has(config.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected)
                      checked === true ? next.add(config.id) : next.delete(config.id)
                      onSelectionChange(next)
                    }}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Text size="small" weight="plus">
                    {config.title}
                  </Text>
                  <Text className="text-ui-fg-muted" size="xsmall">
                    {config.product_title || config.product_id} · {config.variant_ids?.length ?? config.variants?.length ?? 0} variants
                  </Text>
                </Table.Cell>
                <Table.Cell>{humanize(config.delivery_type)}</Table.Cell>
                <Table.Cell>
                  {config.active_release?.version ??
                    config.releases?.find((release) => release.id === config.active_release_id)
                      ?.version ??
                    "—"}
                </Table.Cell>
                <Table.Cell>
                  {config.assets?.length ?? config.active_release?.assets?.length ?? 0}
                </Table.Cell>
                <Table.Cell>
                  <DigitalStatusBadge status={config.status} />
                </Table.Cell>
                <Table.Cell>{formatDate(config.updated_at)}</Table.Cell>
              </Table.Row>
            ))}
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
