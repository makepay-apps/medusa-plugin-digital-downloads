import { Key, Plus } from "@medusajs/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Checkbox,
  Container,
  Heading,
  Input,
  Select,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"

import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback-state"
import { Field } from "../../../components/field"
import { PageHeader } from "../../../components/page-header"
import { DigitalStatusBadge } from "../../../components/status-badge"
import { formatDate, getErrorMessage, humanize } from "../../../lib/format"
import { digitalDownloadKeys } from "../../../lib/query-keys"
import { digitalDownloadsApi } from "../../../lib/sdk"
import type { LicensePolicyInput } from "../../../types/digital-downloads"

const POLICY_PAGE_SIZE = 20
const KEY_PAGE_SIZE = 20

const LicenseManagementPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [selectedPolicyId, setSelectedPolicyId] = useState("")
  const [policyPage, setPolicyPage] = useState(0)
  const [keyPage, setKeyPage] = useState(0)
  const [keyStatus, setKeyStatus] = useState("")
  const [importText, setImportText] = useState("")
  const [duplicatePolicy, setDuplicatePolicy] = useState<"reject" | "skip">("skip")

  const policyFilters = useMemo(
    () => ({ limit: POLICY_PAGE_SIZE, offset: policyPage * POLICY_PAGE_SIZE }),
    [policyPage]
  )
  const policiesQuery = useQuery({
    queryKey: digitalDownloadKeys.licensePolicies(policyFilters),
    queryFn: () => digitalDownloadsApi.listLicensePolicies(policyFilters),
  })

  useEffect(() => {
    if (
      !selectedPolicyId &&
      policiesQuery.data?.items.length
    ) {
      setSelectedPolicyId(policiesQuery.data.items[0].id)
    }
  }, [policiesQuery.data, selectedPolicyId])

  const keyFilters = useMemo(
    () => ({
      status: keyStatus || undefined,
      limit: KEY_PAGE_SIZE,
      offset: keyPage * KEY_PAGE_SIZE,
    }),
    [keyPage, keyStatus]
  )
  const keysQuery = useQuery({
    queryKey: digitalDownloadKeys.licenseKeys(selectedPolicyId, keyFilters),
    queryFn: () => digitalDownloadsApi.listLicenseKeys(selectedPolicyId, keyFilters),
    enabled: Boolean(selectedPolicyId),
  })

  const selectedPolicy = policiesQuery.data?.items.find(
    (policy) => policy.id === selectedPolicyId
  )

  const importMutation = useMutation({
    mutationFn: (keys: string[]) =>
      digitalDownloadsApi.importLicenseKeys(selectedPolicyId, {
        keys,
        duplicate_policy: duplicatePolicy,
      }),
    onSuccess: async (result) => {
      setImportText("")
      toast.success(
        result.imported !== undefined
          ? `${result.imported} license keys imported.`
          : "License keys imported securely."
      )
      await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const importKeys = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const keys = Array.from(
      new Set(
        importText
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    )
    if (!keys.length) {
      toast.error("Paste at least one license key.")
      return
    }
    importMutation.mutate(keys)
  }

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        actions={
          <Button onClick={() => setShowCreate((visible) => !visible)}>
            <Plus />
            Create policy
          </Button>
        }
        description="Configure generated or pooled licenses with online activation and validation."
        onBack={() => navigate("/digital-downloads")}
        title="License management"
      />

      {showCreate ? (
        <CreatePolicyPanel
          onCancel={() => setShowCreate(false)}
          onCreated={(id) => {
            setSelectedPolicyId(id)
            setShowCreate(false)
          }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(320px,1fr)_minmax(0,2fr)]">
        <Container className="overflow-hidden p-0">
          <div className="border-b border-ui-border-base px-6 py-4">
            <Heading level="h2">License policies</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              One policy can govern each digital product.
            </Text>
          </div>
          {policiesQuery.isLoading ? <LoadingState rows={4} /> : null}
          {policiesQuery.isError ? (
            <ErrorState
              message={getErrorMessage(policiesQuery.error)}
              onRetry={() => void policiesQuery.refetch()}
            />
          ) : null}
          {policiesQuery.data && !policiesQuery.data.items.length ? (
            <EmptyState
              action={
                <Button onClick={() => setShowCreate(true)} size="small">
                  Create policy
                </Button>
              }
              description="Add a policy for generated keys, pooled keys, or no license delivery."
              title="No license policies"
            />
          ) : null}
          {policiesQuery.data?.items.length ? (
            <>
              <div className="divide-y">
                {policiesQuery.data.items.map((policy) => (
                  <button
                    className={`flex w-full items-center justify-between gap-3 px-6 py-4 text-left hover:bg-ui-bg-subtle ${
                      selectedPolicyId === policy.id ? "bg-ui-bg-subtle" : ""
                    }`}
                    key={policy.id}
                    onClick={() => {
                      setSelectedPolicyId(policy.id)
                      setKeyPage(0)
                    }}
                    type="button"
                  >
                    <span className="min-w-0">
                      <Text className="truncate" size="small" weight="plus">
                        {policy.name || policy.product_title || policy.digital_product_id || policy.id}
                      </Text>
                      <Text className="text-ui-fg-muted" size="xsmall">
                        {humanize(policy.strategy || policy.type)} ·{" "}
                        {policy.activation_limit ?? "Unlimited"} activations
                      </Text>
                    </span>
                    <DigitalStatusBadge
                      status={
                        policy.status || (policy.is_enabled === false ? "inactive" : "active")
                      }
                    />
                  </button>
                ))}
              </div>
              <Table.Pagination
                canNextPage={(policyPage + 1) * POLICY_PAGE_SIZE < policiesQuery.data.count}
                canPreviousPage={policyPage > 0}
                count={policiesQuery.data.count}
                nextPage={() => setPolicyPage((page) => page + 1)}
                pageCount={Math.max(
                  1,
                  Math.ceil(policiesQuery.data.count / POLICY_PAGE_SIZE)
                )}
                pageIndex={policyPage}
                pageSize={POLICY_PAGE_SIZE}
                previousPage={() => setPolicyPage((page) => Math.max(0, page - 1))}
              />
            </>
          ) : null}
        </Container>

        <div className="flex min-w-0 flex-col gap-3">
          {selectedPolicy ? (
            <>
              <Container className="p-0">
                <div className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Key className="text-ui-fg-muted" />
                      <Heading level="h2">
                        {selectedPolicy.name ||
                          selectedPolicy.product_title ||
                          "License inventory"}
                      </Heading>
                    </div>
                    <Text className="text-ui-fg-subtle" size="small">
                      {humanize(selectedPolicy.strategy || selectedPolicy.type)} strategy ·{" "}
                      {selectedPolicy.validity_days ?? "No"} day validity
                    </Text>
                  </div>
                  {selectedPolicy.key_counts ? (
                    <div className="flex flex-wrap gap-1">
                      <Badge color="green" size="xsmall">
                        {selectedPolicy.key_counts.available} available
                      </Badge>
                      <Badge color="orange" size="xsmall">
                        {selectedPolicy.key_counts.reserved} reserved
                      </Badge>
                      <Badge color="blue" size="xsmall">
                        {selectedPolicy.key_counts.assigned} assigned
                      </Badge>
                    </div>
                  ) : null}
                </div>
              </Container>

              {(selectedPolicy.strategy || selectedPolicy.type) === "pool" ? (
                <Container className="divide-y p-0">
                  <div className="px-6 py-4">
                    <Heading level="h2">Import pooled keys</Heading>
                    <Text className="text-ui-fg-subtle" size="small">
                      Plaintext is encrypted on receipt and is never returned to Admin.
                    </Text>
                  </div>
                  <form className="space-y-4 px-6 py-5" onSubmit={importKeys}>
                    <Field
                      htmlFor="license-keys"
                      hint="One key per line"
                      label="License keys"
                      required
                    >
                      <Textarea
                        autoComplete="off"
                        id="license-keys"
                        onChange={(event) => setImportText(event.target.value)}
                        placeholder={"AAAA-BBBB-CCCC-DDDD\nEEEE-FFFF-GGGG-HHHH"}
                        rows={6}
                        spellCheck={false}
                        value={importText}
                      />
                    </Field>
                    <div className="flex items-end justify-between gap-3">
                      <Field htmlFor="duplicate-policy" label="Duplicates">
                        <Select
                          onValueChange={(value) =>
                            setDuplicatePolicy(value as "reject" | "skip")
                          }
                          value={duplicatePolicy}
                        >
                          <Select.Trigger className="w-44" id="duplicate-policy">
                            <Select.Value />
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="skip">Skip duplicates</Select.Item>
                            <Select.Item value="reject">Reject whole import</Select.Item>
                          </Select.Content>
                        </Select>
                      </Field>
                      <Button isLoading={importMutation.isPending} type="submit">
                        Import keys
                      </Button>
                    </div>
                  </form>
                </Container>
              ) : null}

              <Container className="overflow-hidden p-0">
                <div className="flex items-center justify-between gap-3 border-b border-ui-border-base px-6 py-4">
                  <div>
                    <Heading level="h2">Key inventory</Heading>
                    <Text className="text-ui-fg-subtle" size="small">
                      Only non-secret hints and lifecycle status are displayed.
                    </Text>
                  </div>
                  <Select
                    onValueChange={(value) => {
                      setKeyStatus(value === "all" ? "" : value)
                      setKeyPage(0)
                    }}
                    value={keyStatus || "all"}
                  >
                    <Select.Trigger className="w-36" aria-label="Key status">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">All statuses</Select.Item>
                      <Select.Item value="available">Available</Select.Item>
                      <Select.Item value="reserved">Reserved</Select.Item>
                      <Select.Item value="assigned">Assigned</Select.Item>
                      <Select.Item value="revoked">Revoked</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
                {keysQuery.isLoading ? <LoadingState rows={4} /> : null}
                {keysQuery.isError ? (
                  <ErrorState
                    message={getErrorMessage(keysQuery.error)}
                    onRetry={() => void keysQuery.refetch()}
                  />
                ) : null}
                {keysQuery.data && !keysQuery.data.items.length ? (
                  <EmptyState
                    description={
                      (selectedPolicy.strategy || selectedPolicy.type) === "pool"
                        ? "Import keys above to create available inventory."
                        : "Keys appear here when the configured provider issues them."
                    }
                    title="No keys in this view"
                  />
                ) : null}
                {keysQuery.data?.items.length ? (
                  <>
                    <Table>
                      <Table.Header>
                        <Table.Row>
                          <Table.HeaderCell>Key hint</Table.HeaderCell>
                          <Table.HeaderCell>Batch</Table.HeaderCell>
                          <Table.HeaderCell>Assigned</Table.HeaderCell>
                          <Table.HeaderCell>Status</Table.HeaderCell>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {keysQuery.data.items.map((key) => (
                          <Table.Row key={key.id}>
                            <Table.Cell>
                              <span className="font-mono txt-compact-small">
                                {key.key_hint}
                              </span>
                            </Table.Cell>
                            <Table.Cell>{key.batch_id || "—"}</Table.Cell>
                            <Table.Cell>{formatDate(key.assigned_at)}</Table.Cell>
                            <Table.Cell>
                              <DigitalStatusBadge status={key.status} />
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                    <Table.Pagination
                      canNextPage={(keyPage + 1) * KEY_PAGE_SIZE < keysQuery.data.count}
                      canPreviousPage={keyPage > 0}
                      count={keysQuery.data.count}
                      nextPage={() => setKeyPage((page) => page + 1)}
                      pageCount={Math.max(
                        1,
                        Math.ceil(keysQuery.data.count / KEY_PAGE_SIZE)
                      )}
                      pageIndex={keyPage}
                      pageSize={KEY_PAGE_SIZE}
                      previousPage={() => setKeyPage((page) => Math.max(0, page - 1))}
                    />
                  </>
                ) : null}
              </Container>
            </>
          ) : (
            <Container>
              <EmptyState
                description="Choose or create a policy to inspect its license inventory."
                title="Select a license policy"
              />
            </Container>
          )}
        </div>
      </div>
    </div>
  )
}

interface CreatePolicyPanelProps {
  onCancel: () => void
  onCreated: (id: string) => void
}

const CreatePolicyPanel = ({ onCancel, onCreated }: CreatePolicyPanelProps) => {
  const queryClient = useQueryClient()
  const [productConfigId, setProductConfigId] = useState("")
  const [strategy, setStrategy] = useState<LicensePolicyInput["strategy"]>("pool")
  const [pattern, setPattern] = useState("XXXX-XXXX-XXXX-XXXX")
  const [activationLimit, setActivationLimit] = useState("1")
  const [validityDays, setValidityDays] = useState("")
  const [requireDevice, setRequireDevice] = useState(true)
  const configsQuery = useQuery({
    queryKey: digitalDownloadKeys.configs({ licenses: true }),
    queryFn: () =>
      digitalDownloadsApi.listProductConfigs({ limit: 100, offset: 0 }),
  })
  const createMutation = useMutation({
    mutationFn: (input: LicensePolicyInput) =>
      digitalDownloadsApi.createLicensePolicy(input),
    onSuccess: async (policy) => {
      toast.success("License policy created.")
      await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
      onCreated(policy.id)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!productConfigId) {
      toast.error("Choose a digital product.")
      return
    }
    createMutation.mutate({
      digital_product_id: productConfigId,
      strategy,
      license_pattern: strategy === "generated" ? pattern.trim() || null : null,
      activation_limit:
        strategy === "none"
          ? null
          : activationLimit.trim()
            ? Number(activationLimit)
            : null,
      validity_days:
        strategy === "none"
          ? null
          : validityDays.trim()
            ? Number(validityDays)
            : null,
      allow_offline_activation: false,
      require_device_id: strategy === "none" ? false : requireDevice,
      is_enabled: true,
    })
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Create license policy</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Associate the policy with a digital product configuration.
        </Text>
      </div>
      <form className="grid grid-cols-1 gap-5 px-6 py-5 md:grid-cols-2" onSubmit={submit}>
        <Field htmlFor="policy-product" label="Digital product" required>
          <Select onValueChange={setProductConfigId} value={productConfigId}>
            <Select.Trigger id="policy-product">
              <Select.Value placeholder="Choose a configuration" />
            </Select.Trigger>
            <Select.Content>
              {configsQuery.data?.items.map((config) => (
                <Select.Item key={config.id} value={config.id}>
                  {config.title}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </Field>
        <Field htmlFor="policy-strategy" label="Strategy">
          <Select
            onValueChange={(value) =>
              setStrategy(value as LicensePolicyInput["strategy"])
            }
            value={strategy}
          >
            <Select.Trigger id="policy-strategy">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="pool">Imported key pool</Select.Item>
              <Select.Item value="generated">Generated keys</Select.Item>
              <Select.Item value="none">No license delivery</Select.Item>
            </Select.Content>
          </Select>
        </Field>
        {strategy === "generated" ? (
          <Field htmlFor="license-pattern" label="Key pattern">
            <Input
              id="license-pattern"
              onChange={(event) => setPattern(event.target.value)}
              value={pattern}
            />
          </Field>
        ) : null}
        {strategy !== "none" ? (
          <>
            <Field htmlFor="activation-limit" hint="Blank = unlimited" label="Activation limit">
              <Input
                id="activation-limit"
                min={0}
                onChange={(event) => setActivationLimit(event.target.value)}
                type="number"
                value={activationLimit}
              />
            </Field>
            <Field htmlFor="validity-days" hint="Blank = perpetual" label="License validity">
              <Input
                id="validity-days"
                min={1}
                onChange={(event) => setValidityDays(event.target.value)}
                type="number"
                value={validityDays}
              />
            </Field>
            <div className="space-y-3 md:col-span-2">
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={requireDevice}
                  onCheckedChange={(checked) => setRequireDevice(checked === true)}
                />
                <span>
                  <Text size="small" weight="plus">
                    Require device identifier
                  </Text>
                  <Text className="text-ui-fg-subtle" size="xsmall">
                    Activations use the online validation endpoint and identify a stable customer device.
                  </Text>
                </span>
              </label>
            </div>
          </>
        ) : (
          <Text className="text-ui-fg-subtle md:col-span-2" size="small">
            This product will not issue or require a license key.
          </Text>
        )}
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button onClick={onCancel} type="button" variant="secondary">
            Cancel
          </Button>
          <Button isLoading={createMutation.isPending} type="submit">
            Create policy
          </Button>
        </div>
      </form>
    </Container>
  )
}

export default LicenseManagementPage
