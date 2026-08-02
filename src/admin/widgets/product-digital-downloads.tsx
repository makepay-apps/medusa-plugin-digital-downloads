import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { CloudArrowDown, Plus } from "@medusajs/icons"
import type { AdminProduct, DetailWidgetProps } from "@medusajs/framework/types"
import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Container, Heading, Table, Text } from "@medusajs/ui"
import { useNavigate } from "react-router-dom"

import { ErrorState, LoadingState } from "../components/feedback-state"
import { DigitalStatusBadge } from "../components/status-badge"
import { getErrorMessage, humanize } from "../lib/format"
import { digitalDownloadKeys } from "../lib/query-keys"
import { digitalDownloadsApi } from "../lib/sdk"

const ProductDigitalDownloadsWidget = ({
  data: product,
}: DetailWidgetProps<AdminProduct>) => {
  const navigate = useNavigate()
  const configsQuery = useQuery({
    queryKey: digitalDownloadKeys.configs({ product_id: product.id }),
    queryFn: () =>
      digitalDownloadsApi.listProductConfigs({
        product_id: product.id,
        limit: 100,
        offset: 0,
      }),
  })

  if (configsQuery.isLoading) {
    return <LoadingState rows={2} />
  }

  return (
    <Container className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <CloudArrowDown className="text-ui-fg-muted" />
            <Heading level="h2">Digital delivery</Heading>
          </div>
          <Text className="text-ui-fg-subtle" size="small">
            Protected files, releases, streaming, and software licenses.
          </Text>
        </div>
        <Button
          onClick={() => navigate(`/digital-downloads/create?product_id=${product.id}`)}
          size="small"
          variant={configsQuery.data?.items.length ? "secondary" : "primary"}
        >
          <Plus />
          Configure
        </Button>
      </div>

      {configsQuery.isError ? (
        <ErrorState
          message={getErrorMessage(configsQuery.error)}
          onRetry={() => void configsQuery.refetch()}
          title="Digital delivery could not be loaded"
        />
      ) : null}

      {configsQuery.data && !configsQuery.data.items.length ? (
        <div className="border-t border-ui-border-base px-6 py-8 text-center">
          <Text size="small" weight="plus">
            This product is not configured for digital delivery.
          </Text>
          <Text className="mt-1 text-ui-fg-subtle" size="xsmall">
            Associate variants and publish a release to begin automatic fulfillment.
          </Text>
        </div>
      ) : null}

      {configsQuery.data?.items.length ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Configuration</Table.HeaderCell>
              <Table.HeaderCell>Variants</Table.HeaderCell>
              <Table.HeaderCell>Delivery</Table.HeaderCell>
              <Table.HeaderCell>Active release</Table.HeaderCell>
              <Table.HeaderCell>Assets</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {configsQuery.data.items.map((config) => (
              <Table.Row
                className="cursor-pointer"
                key={config.id}
                onClick={() => navigate(`/digital-downloads/${config.id}`)}
              >
                <Table.Cell>
                  <Text size="small" weight="plus">
                    {config.title}
                  </Text>
                  {config.license_policy ? (
                    <Badge className="mt-1" color="purple" size="2xsmall">
                      {config.license_policy.name ||
                        humanize(
                          config.license_policy.strategy ||
                            config.license_policy.type
                        )}
                    </Badge>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  {config.variants?.length ?? config.variant_ids?.length ?? 0}
                </Table.Cell>
                <Table.Cell>{humanize(config.delivery_type)}</Table.Cell>
                <Table.Cell>
                  {config.active_release?.version || config.active_release_id || "—"}
                </Table.Cell>
                <Table.Cell>
                  {config.assets?.length ?? config.active_release?.assets?.length ?? 0}
                </Table.Cell>
                <Table.Cell>
                  <DigitalStatusBadge status={config.status} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductDigitalDownloadsWidget
