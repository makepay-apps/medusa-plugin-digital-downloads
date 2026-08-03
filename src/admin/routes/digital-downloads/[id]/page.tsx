import {
  ArrowUpRightOnBox,
  CloudArrowUp,
  PencilSquare,
  Plus,
  Trash,
} from "@medusajs/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Select,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { type FormEvent, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { EntitlementTable } from "../../../components/entitlement-table"
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback-state"
import { Field } from "../../../components/field"
import { PageHeader } from "../../../components/page-header"
import { SectionRow } from "../../../components/section-row"
import { DigitalStatusBadge } from "../../../components/status-badge"
import { UploadPanel } from "../../../components/upload-panel"
import { formatBytes, formatDate, getErrorMessage, humanize } from "../../../lib/format"
import { digitalDownloadKeys } from "../../../lib/query-keys"
import { hasPublishableReleaseDeliverables } from "../../../lib/release-readiness"
import { digitalDownloadsApi } from "../../../lib/sdk"
import type {
  DeliveryType,
  DigitalRelease,
  EntitlementFilters,
  EntitlementStatus,
  LicensePolicy,
} from "../../../types/digital-downloads"

const ENTITLEMENT_PAGE_SIZE = 10

const DigitalDownloadDetailPage = () => {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [releaseVersion, setReleaseVersion] = useState("1.0.0")
  const [releaseTitle, setReleaseTitle] = useState("Release")
  const [releaseNotes, setReleaseNotes] = useState("")
  const [selectedReleaseId, setSelectedReleaseId] = useState("")
  const [entitlementQuery, setEntitlementQuery] = useState("")
  const [entitlementStatus, setEntitlementStatus] = useState<EntitlementStatus | "">("")
  const [entitlementPage, setEntitlementPage] = useState(0)
  const [selectedEntitlements, setSelectedEntitlements] = useState<Set<string>>(new Set())

  const configQuery = useQuery({
    queryKey: digitalDownloadKeys.config(id),
    queryFn: () => digitalDownloadsApi.getProductConfig(id),
    enabled: Boolean(id),
  })
  const settingsQuery = useQuery({
    queryKey: digitalDownloadKeys.settings(),
    queryFn: () => digitalDownloadsApi.getSettings(),
  })

  const entitlementFilters = useMemo<EntitlementFilters>(
    () => ({
      product_config_id: id,
      q: entitlementQuery || undefined,
      status: entitlementStatus,
      limit: ENTITLEMENT_PAGE_SIZE,
      offset: entitlementPage * ENTITLEMENT_PAGE_SIZE,
      order: "-created_at",
    }),
    [entitlementPage, entitlementQuery, entitlementStatus, id]
  )
  const entitlementsQuery = useQuery({
    queryKey: digitalDownloadKeys.entitlements(entitlementFilters),
    queryFn: () => digitalDownloadsApi.listEntitlements(entitlementFilters),
    enabled: Boolean(id),
  })

  const invalidateDetail = async () => {
    await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
  }

  const releaseMutation = useMutation({
    mutationFn: () =>
      digitalDownloadsApi.createRelease({
        product_config_id: id,
        version: releaseVersion.trim(),
        title: releaseTitle.trim(),
        notes: releaseNotes.trim() || null,
      }),
    onSuccess: async (release) => {
      setSelectedReleaseId(release.id)
      setReleaseTitle("Release")
      setReleaseNotes("")
      toast.success(`Release ${release.version} created.`)
      await invalidateDetail()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const publishMutation = useMutation({
    mutationFn: async (releaseId: string) => {
      const release = configQuery.data?.releases?.find(
        (candidate) => candidate.id === releaseId
      )
      if (release?.status === "draft") {
        await digitalDownloadsApi.updateRelease(releaseId, { status: "ready" })
      }
      return digitalDownloadsApi.publishRelease(releaseId)
    },
    onSuccess: async () => {
      toast.success("Release published. New entitlements will use it immediately.")
      await invalidateDetail()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const assetDeleteMutation = useMutation({
    mutationFn: (assetId: string) => digitalDownloadsApi.deleteAsset(assetId),
    onSuccess: async () => {
      toast.success("Asset removed.")
      await invalidateDetail()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const revokeMutation = useMutation({
    mutationFn: (entitlementIds: string[]) =>
      Promise.all(
        entitlementIds.map((entitlementId) =>
          digitalDownloadsApi.revokeEntitlement(
            entitlementId,
            "Revoked by an administrator"
          )
        )
      ),
    onSuccess: async () => {
      setSelectedEntitlements(new Set())
      toast.success("Selected entitlements revoked.")
      await invalidateDetail()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const reissueMutation = useMutation({
    mutationFn: (entitlementId: string) =>
      digitalDownloadsApi.reissueEntitlement(entitlementId),
    onSuccess: async () => {
      toast.success("Entitlement reissued.")
      await invalidateDetail()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const deleteMutation = useMutation({
    mutationFn: () => digitalDownloadsApi.deleteProductConfig(id),
    onSuccess: async () => {
      toast.success("Digital product configuration deleted.")
      await invalidateDetail()
      navigate("/digital-downloads")
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const createRelease = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!releaseVersion.trim() || !releaseTitle.trim()) {
      toast.error("Enter a release version and title.")
      return
    }
    releaseMutation.mutate()
  }

  if (configQuery.isLoading) {
    return <LoadingState rows={8} />
  }

  if (configQuery.isError || !configQuery.data) {
    return (
      <ErrorState
        message={getErrorMessage(configQuery.error ?? "Configuration not found.")}
        onRetry={() => void configQuery.refetch()}
      />
    )
  }

  const config = configQuery.data
  const releases = config.releases ?? []
  const displayedVariants = config.variants?.length
    ? config.variants
    : (config.variant_ids ?? []).map((variantId) => ({
        id: variantId,
        title: null,
        sku: null,
      }))
  const draftReleases = releases.filter((release) => release.status === "draft")
  const uploadReleaseId =
    (draftReleases.some((release) => release.id === selectedReleaseId)
      ? selectedReleaseId
      : draftReleases[0]?.id) ?? ""

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        actions={
          <>
            <Button
              onClick={() => navigate(`/products/${config.product_id}`)}
              variant="secondary"
            >
              View product
              <ArrowUpRightOnBox />
            </Button>
            <Button
              onClick={() => navigate(`/digital-downloads/${config.id}/edit`)}
              variant="secondary"
            >
              <PencilSquare />
              Edit
            </Button>
          </>
        }
        description={config.product_title || config.product_id}
        onBack={() => navigate("/digital-downloads")}
        title={config.title}
      />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <Heading level="h2">Delivery configuration</Heading>
                <Text className="text-ui-fg-subtle" size="small">
                  Customer access and fulfillment behavior.
                </Text>
              </div>
              <DigitalStatusBadge status={config.status} />
            </div>
            <SectionRow label="Delivery" value={humanize(config.delivery_type)} />
            <SectionRow
              label="Fulfillment"
              value={humanize(config.fulfillment_strategy)}
            />
            <SectionRow
              label="Download limit"
              value={config.download_limit ?? "Unlimited"}
            />
            <SectionRow
              label="Access expiry"
              value={config.expires_in_days ? `${config.expires_in_days} days` : "Never"}
            />
            <SectionRow
              label="Variants"
              value={
                <div className="flex flex-wrap gap-1">
                  {displayedVariants.map((variant) => (
                    <Badge key={variant.id} size="xsmall">
                      {variant.title || variant.sku || variant.id}
                    </Badge>
                  ))}
                </div>
              }
            />
            {config.license_policy ? (
              <SectionRow
                label="License policy"
                value={`${
                  config.license_policy.name ||
                  config.license_policy.product_title ||
                  config.license_policy.id
                } · ${humanize(
                  config.license_policy.strategy || config.license_policy.type
                )}`}
              />
            ) : null}
          </Container>

          <Container className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-ui-border-base px-6 py-4">
              <div>
                <Heading level="h2">Releases and assets</Heading>
                <Text className="text-ui-fg-subtle" size="small">
                  Version files safely and decide which release customers receive.
                </Text>
              </div>
              <Badge size="xsmall">
                {releases.length} {releases.length === 1 ? "release" : "releases"}
              </Badge>
            </div>
            {!releases.length ? (
              <EmptyState
                description={
                  config.delivery_type === "license"
                    ? "Create a release below, configure an enabled generated or pool license policy, then publish it."
                    : "Create a draft release below, upload one or more files, then publish it."
                }
                title="No releases yet"
              />
            ) : (
              <div className="divide-y">
                {releases.map((release) => (
                  <ReleaseRow
                    deletingAssetId={
                      assetDeleteMutation.isPending ? assetDeleteMutation.variables : undefined
                    }
                    isPublishing={
                      publishMutation.isPending && publishMutation.variables === release.id
                    }
                    key={release.id}
                    onDeleteAsset={(assetId) => {
                      if (window.confirm("Remove this asset? Existing signed links will stop working.")) {
                        assetDeleteMutation.mutate(assetId)
                      }
                    }}
                    onPublish={() => publishMutation.mutate(release.id)}
                    deliveryType={config.delivery_type}
                    licensePolicy={config.license_policy}
                    release={release}
                  />
                ))}
              </div>
            )}
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">Create a release</Heading>
              <Text className="text-ui-fg-subtle" size="small">
                A draft can receive files without changing the active customer release.
              </Text>
            </div>
            <form
              className="grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-2"
              onSubmit={createRelease}
            >
              <Field htmlFor="release-version" label="Version" required>
                <Input
                  id="release-version"
                  onChange={(event) => setReleaseVersion(event.target.value)}
                  placeholder="1.0.0"
                  value={releaseVersion}
                />
              </Field>
              <Field htmlFor="release-name" label="Title" required>
                <Input
                  id="release-name"
                  onChange={(event) => setReleaseTitle(event.target.value)}
                  placeholder="Launch edition"
                  value={releaseTitle}
                />
              </Field>
              <div className="md:col-span-2">
                <Field htmlFor="release-notes" label="Release notes">
                  <Textarea
                    id="release-notes"
                    onChange={(event) => setReleaseNotes(event.target.value)}
                    placeholder="What changed in this release?"
                    rows={3}
                    value={releaseNotes}
                  />
                </Field>
              </div>
              <div className="flex justify-end md:col-span-2">
                <Button isLoading={releaseMutation.isPending} type="submit">
                  <Plus />
                  Create draft release
                </Button>
              </div>
            </form>
          </Container>

          <Container className="divide-y p-0">
            <div className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <Heading level="h2">Upload assets</Heading>
                <Text className="text-ui-fg-subtle" size="small">
                  Local and S3 storage use the same protected upload flow.
                </Text>
              </div>
              {draftReleases.length ? (
                <Select onValueChange={setSelectedReleaseId} value={uploadReleaseId}>
                  <Select.Trigger className="w-52" aria-label="Draft release">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {draftReleases.map((release) => (
                      <Select.Item key={release.id} value={release.id}>
                        {release.version}{" "}
                        {release.name || release.title
                          ? `— ${release.name || release.title}`
                          : ""}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              ) : null}
            </div>
            <div className="px-6 py-5">
              {uploadReleaseId ? (
                <UploadPanel
                  allowedMimeTypes={settingsQuery.data?.allowed_mime_types}
                  maxSizeMb={settingsQuery.data?.max_upload_size_mb}
                  onComplete={() => void invalidateDetail()}
                  releaseId={uploadReleaseId}
                  storageProvider={settingsQuery.data?.storage.provider}
                />
              ) : (
                <div className="flex flex-col items-center py-8 text-center">
                  <CloudArrowUp className="text-ui-fg-muted" />
                  <Text className="mt-2" size="small" weight="plus">
                    Create a draft release before uploading files.
                  </Text>
                </div>
              )}
            </div>
          </Container>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">Overview</Heading>
            </div>
            <SectionRow label="Config ID" value={<code>{config.id}</code>} />
            <SectionRow
              label="Active release"
              value={config.active_release?.version || config.active_release_id || "None"}
            />
            <SectionRow label="Created" value={formatDate(config.created_at)} />
            <SectionRow label="Updated" value={formatDate(config.updated_at)} />
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">Danger zone</Heading>
              <Text className="text-ui-fg-subtle" size="small">
                Deletion is blocked by the backend when protected history must be retained.
              </Text>
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-4">
              <div>
                <Text size="small" weight="plus">
                  Delete configuration
                </Text>
                <Text className="text-ui-fg-muted" size="xsmall">
                  Does not silently delete customer order history.
                </Text>
              </div>
              <Button
                isLoading={deleteMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete this configuration? This cannot be undone if the server permits it."
                    )
                  ) {
                    deleteMutation.mutate()
                  }
                }}
                size="small"
                variant="danger"
              >
                <Trash />
                Delete
              </Button>
            </div>
          </Container>
        </div>
      </div>

      <Container className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-ui-border-base px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <Heading level="h2">Customer entitlements</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              Audit delivery, masked license fulfillment, expiry, and download usage.
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedEntitlements.size ? (
              <Button
                isLoading={revokeMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke ${selectedEntitlements.size} selected entitlements?`
                    )
                  ) {
                    revokeMutation.mutate(Array.from(selectedEntitlements))
                  }
                }}
                size="small"
                variant="danger"
              >
                Revoke selected ({selectedEntitlements.size})
              </Button>
            ) : null}
            <Input
              aria-label="Search entitlements"
              className="w-56"
              onChange={(event) => {
                setEntitlementQuery(event.target.value)
                setEntitlementPage(0)
              }}
              placeholder="Order, customer, or item"
              type="search"
              value={entitlementQuery}
            />
            <Select
              onValueChange={(value) => {
                setEntitlementStatus(value === "all" ? "" : (value as EntitlementStatus))
                setEntitlementPage(0)
              }}
              value={entitlementStatus || "all"}
            >
              <Select.Trigger className="w-36" aria-label="Entitlement status">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="all">All statuses</Select.Item>
                <Select.Item value="active">Active</Select.Item>
                <Select.Item value="pending">Pending</Select.Item>
                <Select.Item value="suspended">Suspended</Select.Item>
                <Select.Item value="refunded">Refunded</Select.Item>
                <Select.Item value="expired">Expired</Select.Item>
                <Select.Item value="exhausted">Exhausted</Select.Item>
                <Select.Item value="revoked">Revoked</Select.Item>
              </Select.Content>
            </Select>
          </div>
        </div>
        {entitlementsQuery.isLoading ? <LoadingState /> : null}
        {entitlementsQuery.isError ? (
          <ErrorState
            message={getErrorMessage(entitlementsQuery.error)}
            onRetry={() => void entitlementsQuery.refetch()}
          />
        ) : null}
        {entitlementsQuery.data && !entitlementsQuery.data.items.length ? (
          <EmptyState
            description="Entitlements appear after a paid or manually fulfilled digital order."
            title="No customer entitlements"
          />
        ) : null}
        {entitlementsQuery.data?.items.length ? (
          <EntitlementTable
            data={entitlementsQuery.data}
            isMutating={reissueMutation.isPending || revokeMutation.isPending}
            onPageChange={(page) => {
              setEntitlementPage(page)
              setSelectedEntitlements(new Set())
            }}
            onReissue={(entitlementId) => reissueMutation.mutate(entitlementId)}
            onSelectionChange={setSelectedEntitlements}
            pageIndex={entitlementPage}
            pageSize={ENTITLEMENT_PAGE_SIZE}
            selected={selectedEntitlements}
          />
        ) : null}
      </Container>
    </div>
  )
}

interface ReleaseRowProps {
  release: DigitalRelease
  deliveryType: DeliveryType
  licensePolicy?: LicensePolicy | null
  isPublishing: boolean
  deletingAssetId?: string
  onPublish: () => void
  onDeleteAsset: (assetId: string) => void
}

const ReleaseRow = ({
  release,
  deliveryType,
  licensePolicy,
  isPublishing,
  deletingAssetId,
  onPublish,
  onDeleteAsset,
}: ReleaseRowProps) => {
  const hasDeliverables = hasPublishableReleaseDeliverables({
    deliveryType,
    licensePolicy,
    release,
  })
  const licenseOnlyWithoutFiles =
    deliveryType === "license" && !(release.assets?.length ?? 0)

  return (
  <div className="px-6 py-4">
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <Text size="small" weight="plus">
            {release.version}{" "}
            {release.name || release.title
              ? `— ${release.name || release.title}`
              : ""}
          </Text>
          <DigitalStatusBadge status={release.status} />
        </div>
        <Text className="mt-1 text-ui-fg-subtle" size="xsmall">
          {release.release_notes || "No release notes"} · Created {formatDate(release.created_at)}
        </Text>
      </div>
      {["draft", "ready"].includes(release.status) ? (
        <Button
          disabled={!hasDeliverables}
          isLoading={isPublishing}
          onClick={onPublish}
          size="small"
          variant="secondary"
        >
          Publish release
        </Button>
      ) : null}
    </div>
    {release.assets?.length ? (
      <Table className="mt-3">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>File</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Size</Table.HeaderCell>
            <Table.HeaderCell>Storage</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {release.assets.map((asset) => (
            <Table.Row key={asset.id}>
              <Table.Cell>
                <Text size="small" weight="plus">
                  {asset.name || asset.filename || asset.original_filename}
                </Text>
                <Text className="font-mono text-ui-fg-muted" size="xsmall">
                  {asset.checksum_sha256 ? `${asset.checksum_sha256.slice(0, 12)}…` : asset.id}
                </Text>
              </Table.Cell>
              <Table.Cell>{asset.mime_type}</Table.Cell>
              <Table.Cell>{formatBytes(asset.size ?? asset.size_bytes)}</Table.Cell>
              <Table.Cell>{humanize(asset.storage_provider || asset.role)}</Table.Cell>
              <Table.Cell>
                <DigitalStatusBadge
                  status={asset.status || (asset.is_enabled === false ? "inactive" : "ready")}
                />
              </Table.Cell>
              <Table.Cell>
                {release.status === "draft" ? (
                  <Button
                    aria-label={`Delete ${
                      asset.filename || asset.original_filename || asset.name
                    }`}
                    isLoading={deletingAssetId === asset.id}
                    onClick={() => onDeleteAsset(asset.id)}
                    size="small"
                    variant="transparent"
                  >
                    <Trash />
                  </Button>
                ) : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    ) : (
      <Text className="mt-3 text-ui-fg-muted" size="small">
        {licenseOnlyWithoutFiles && hasDeliverables
          ? "No files required; this release uses the enabled license policy."
          : "No files uploaded."}
      </Text>
    )}
  </div>
  )
}

export default DigitalDownloadDetailPage
