import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { CloudArrowDown, Key } from "@medusajs/icons"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, Container, Heading, Table, Text, toast } from "@medusajs/ui"

import { DigitalStatusBadge } from "../components/status-badge"
import { formatDate, getErrorMessage } from "../lib/format"
import { digitalDownloadKeys } from "../lib/query-keys"
import { digitalDownloadsApi } from "../lib/sdk"

const OrderDigitalDownloadsWidget = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  const queryClient = useQueryClient()
  const filters = { order_id: order.id, limit: 100, offset: 0 }
  const entitlementsQuery = useQuery({
    queryKey: digitalDownloadKeys.entitlements(filters),
    queryFn: () => digitalDownloadsApi.listEntitlements(filters),
  })
  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      digitalDownloadsApi.revokeEntitlement(id, "Revoked from order details"),
    onSuccess: async () => {
      toast.success("Digital entitlement revoked.")
      await queryClient.invalidateQueries({
        queryKey: digitalDownloadKeys.entitlements(filters),
      })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const reissueMutation = useMutation({
    mutationFn: (id: string) => digitalDownloadsApi.reissueEntitlement(id),
    onSuccess: async () => {
      toast.success("Digital entitlement reissued.")
      await queryClient.invalidateQueries({
        queryKey: digitalDownloadKeys.entitlements(filters),
      })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  if (!entitlementsQuery.isLoading && !entitlementsQuery.data?.items.length) {
    return null
  }

  return (
    <Container className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <CloudArrowDown className="text-ui-fg-muted" />
            <Heading level="h2">Digital fulfillment</Heading>
          </div>
          <Text className="text-ui-fg-subtle" size="small">
            Customer access is shown without signed URLs, storage keys, or raw license secrets.
          </Text>
        </div>
        {entitlementsQuery.isLoading ? (
          <Text className="text-ui-fg-muted" size="xsmall">
            Loading…
          </Text>
        ) : null}
      </div>

      {entitlementsQuery.isError ? (
        <div className="border-t border-ui-border-base px-6 py-4">
          <Text className="text-ui-fg-error" size="small">
            {getErrorMessage(entitlementsQuery.error)}
          </Text>
          <Button
            className="mt-2"
            onClick={() => void entitlementsQuery.refetch()}
            size="small"
            variant="secondary"
          >
            Try again
          </Button>
        </div>
      ) : null}

      {entitlementsQuery.data?.items.length ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Item</Table.HeaderCell>
              <Table.HeaderCell>Downloads</Table.HeaderCell>
              <Table.HeaderCell>License fulfillment</Table.HeaderCell>
              <Table.HeaderCell>Expires</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {entitlementsQuery.data.items.map((entitlement) => {
              const downloadCount =
                entitlement.downloads?.count ?? entitlement.download_count ?? 0
              const downloadLimit =
                entitlement.downloads?.limit ?? entitlement.download_limit
              const isMutating =
                (revokeMutation.isPending && revokeMutation.variables === entitlement.id) ||
                (reissueMutation.isPending && reissueMutation.variables === entitlement.id)

              return (
                <Table.Row key={entitlement.id}>
                  <Table.Cell>
                    <Text size="small" weight="plus">
                      {entitlement.line_item_title ||
                        entitlement.product_title ||
                        "Digital item"}
                    </Text>
                    <Text className="text-ui-fg-muted" size="xsmall">
                      {entitlement.variant_title || entitlement.variant_id || entitlement.id}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {downloadCount} / {downloadLimit ?? "∞"}
                  </Table.Cell>
                  <Table.Cell>
                    {entitlement.license_key_masked ||
                    entitlement.licenses?.[0]?.masked_key ||
                    entitlement.licenses?.[0]?.key_hint ? (
                      <div className="flex items-center gap-1.5">
                        <Key className="text-ui-fg-muted" />
                        <span className="font-mono txt-compact-xsmall">
                          {entitlement.license_key_masked ||
                            entitlement.licenses?.[0]?.masked_key ||
                            entitlement.licenses?.[0]?.key_hint}
                        </span>
                      </div>
                    ) : entitlement.license_status ||
                      entitlement.licenses?.[0]?.status ? (
                      <DigitalStatusBadge
                        status={
                          entitlement.license_status ||
                          entitlement.licenses?.[0]?.status
                        }
                      />
                    ) : (
                      "—"
                    )}
                  </Table.Cell>
                  <Table.Cell>{formatDate(entitlement.expires_at)}</Table.Cell>
                  <Table.Cell>
                    <DigitalStatusBadge status={entitlement.status} />
                  </Table.Cell>
                  <Table.Cell>
                    {entitlement.status === "revoked" || entitlement.status === "expired" ? (
                      <Button
                        isLoading={isMutating}
                        onClick={() => reissueMutation.mutate(entitlement.id)}
                        size="small"
                        variant="transparent"
                      >
                        Reissue
                      </Button>
                    ) : (
                      <Button
                        isLoading={isMutating}
                        onClick={() => {
                          if (window.confirm("Revoke this customer's digital access?")) {
                            revokeMutation.mutate(entitlement.id)
                          }
                        }}
                        size="small"
                        variant="transparent"
                      >
                        Revoke
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderDigitalDownloadsWidget
