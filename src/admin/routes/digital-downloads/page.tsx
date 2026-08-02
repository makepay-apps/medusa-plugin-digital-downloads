import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CloudArrowDown, CogSixTooth, Key, Plus } from "@medusajs/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Select, Text, toast } from "@medusajs/ui"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { EmptyState, ErrorState, LoadingState } from "../../components/feedback-state"
import { MakePayAttribution } from "../../components/makepay-attribution"
import { MetricCard } from "../../components/metric-card"
import { PageHeader } from "../../components/page-header"
import { ProductConfigTable } from "../../components/product-config-table"
import { formatBytes, getErrorMessage } from "../../lib/format"
import { digitalDownloadKeys } from "../../lib/query-keys"
import { digitalDownloadsApi } from "../../lib/sdk"
import type {
  DeliveryType,
  DigitalProductStatus,
  ProductConfigFilters,
} from "../../types/digital-downloads"

const PAGE_SIZE = 20

const DigitalDownloadsPage = () => {
  const { t } = useTranslation("digitalDownloads")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<DigitalProductStatus | "">("")
  const [deliveryType, setDeliveryType] = useState<DeliveryType | "">("")
  const [pageIndex, setPageIndex] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const filters = useMemo<ProductConfigFilters>(
    () => ({
      q: query || undefined,
      status,
      delivery_type: deliveryType,
      limit: PAGE_SIZE,
      offset: pageIndex * PAGE_SIZE,
      order: "-updated_at",
    }),
    [deliveryType, pageIndex, query, status]
  )

  const configsQuery = useQuery({
    queryKey: digitalDownloadKeys.configs(filters),
    queryFn: () => digitalDownloadsApi.listProductConfigs(filters),
  })
  const summaryQuery = useQuery({
    queryKey: digitalDownloadKeys.summary(),
    queryFn: () => digitalDownloadsApi.getSummary(),
  })

  const archiveMutation = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(
        ids.map((id) => digitalDownloadsApi.updateProductConfig(id, { status: "archived" }))
      ),
    onSuccess: async () => {
      setSelected(new Set())
      toast.success(t("overview.archived"))
      await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const hasFilters = Boolean(query || status || deliveryType)

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        actions={
          <>
            <Button onClick={() => navigate("/digital-downloads/licenses")} variant="secondary">
              <Key />
              Licenses
            </Button>
            <Button onClick={() => navigate("/digital-downloads/settings")} variant="secondary">
              <CogSixTooth />
              {t("actions.settings")}
            </Button>
            <Button onClick={() => navigate("/digital-downloads/create")}>
              <Plus />
              {t("actions.create")}
            </Button>
          </>
        }
        description={t("overview.description")}
        title={t("title")}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label={t("metrics.activeProducts")}
          value={summaryQuery.data?.active_product_configs ?? "—"}
        />
        <MetricCard
          label={t("metrics.activeEntitlements")}
          value={summaryQuery.data?.active_entitlements ?? "—"}
        />
        <MetricCard
          label={t("metrics.downloads30d")}
          value={summaryQuery.data?.downloads_30d ?? "—"}
        />
        <MetricCard
          label={t("metrics.storage")}
          value={formatBytes(summaryQuery.data?.storage_bytes)}
        />
      </div>

      <Container className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-ui-border-base px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <Heading level="h2">{t("overview.configurations")}</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              {t("overview.configurationsDescription")}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selected.size ? (
              <Button
                isLoading={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate(Array.from(selected))}
                size="small"
                variant="danger"
              >
                {t("actions.archiveSelected", { count: selected.size })}
              </Button>
            ) : null}
            <Input
              aria-label={t("filters.search")}
              className="w-56"
              onChange={(event) => {
                setQuery(event.target.value)
                setPageIndex(0)
              }}
              placeholder={t("filters.search")}
              type="search"
              value={query}
            />
            <Select
              onValueChange={(value) => {
                setStatus(value === "all" ? "" : (value as DigitalProductStatus))
                setPageIndex(0)
              }}
              value={status || "all"}
            >
              <Select.Trigger className="w-36" aria-label={t("filters.status")}>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="all">{t("filters.allStatuses")}</Select.Item>
                <Select.Item value="active">{t("status.active")}</Select.Item>
                <Select.Item value="draft">{t("status.draft")}</Select.Item>
                <Select.Item value="archived">{t("status.archived")}</Select.Item>
              </Select.Content>
            </Select>
            <Select
              onValueChange={(value) => {
                setDeliveryType(value === "all" ? "" : (value as DeliveryType))
                setPageIndex(0)
              }}
              value={deliveryType || "all"}
            >
              <Select.Trigger className="w-44" aria-label={t("filters.delivery")}>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="all">{t("filters.allDeliveryTypes")}</Select.Item>
                <Select.Item value="download">{t("delivery.download")}</Select.Item>
                <Select.Item value="license">{t("delivery.license")}</Select.Item>
                <Select.Item value="mixed">
                  {t("delivery.downloadAndLicense")}
                </Select.Item>
                <Select.Item value="stream">{t("delivery.stream")}</Select.Item>
              </Select.Content>
            </Select>
          </div>
        </div>

        {configsQuery.isLoading ? <LoadingState /> : null}
        {configsQuery.isError ? (
          <ErrorState
            message={getErrorMessage(configsQuery.error)}
            onRetry={() => void configsQuery.refetch()}
          />
        ) : null}
        {configsQuery.data && !configsQuery.data.items.length ? (
          <EmptyState
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setQuery("")
                    setStatus("")
                    setDeliveryType("")
                  }}
                  size="small"
                  variant="secondary"
                >
                  {t("actions.clearFilters")}
                </Button>
              ) : (
                <Button onClick={() => navigate("/digital-downloads/create")} size="small">
                  {t("actions.create")}
                </Button>
              )
            }
            description={
              hasFilters ? t("empty.filteredDescription") : t("empty.description")
            }
            title={hasFilters ? t("empty.filteredTitle") : t("empty.title")}
          />
        ) : null}
        {configsQuery.data?.items.length ? (
          <ProductConfigTable
            data={configsQuery.data}
            onPageChange={(page) => {
              setPageIndex(page)
              setSelected(new Set())
            }}
            onRowClick={(id) => navigate(`/digital-downloads/${id}`)}
            onSelectionChange={setSelected}
            pageIndex={pageIndex}
            pageSize={PAGE_SIZE}
            selected={selected}
          />
        ) : null}
      </Container>
      <MakePayAttribution />
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Digital Downloads",
  icon: CloudArrowDown,
})

export default DigitalDownloadsPage
