import { CircleStack, CloudSolid } from "@medusajs/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Checkbox,
  Container,
  Heading,
  Input,
  Select,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { type FormEvent, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

import { ErrorState, LoadingState } from "../../../components/feedback-state"
import { Field } from "../../../components/field"
import { MakePayAttribution } from "../../../components/makepay-attribution"
import { PageHeader } from "../../../components/page-header"
import { getErrorMessage, humanize } from "../../../lib/format"
import { digitalDownloadKeys } from "../../../lib/query-keys"
import { digitalDownloadsApi } from "../../../lib/sdk"
import type {
  DigitalDownloadSettings,
  DigitalDownloadSettingsPatch,
} from "../../../types/digital-downloads"

interface SettingsFormState {
  enabled: boolean
  defaultDeliveryType: DigitalDownloadSettings["default_delivery_type"]
  defaultGrantTtlSeconds: string
  maxGrantTtlSeconds: string
  guestAccessTtlSeconds: string
  defaultDownloadLimit: string
  maxUploadSizeMb: string
  allowGuestAccess: boolean
  requireOrderEmailMatch: boolean
  eventRetentionDays: string
}

const toFormState = (settings: DigitalDownloadSettings): SettingsFormState => ({
  enabled: settings.enabled,
  defaultDeliveryType: settings.default_delivery_type,
  defaultGrantTtlSeconds: String(settings.default_grant_ttl_seconds),
  maxGrantTtlSeconds: String(settings.max_grant_ttl_seconds),
  guestAccessTtlSeconds: String(settings.guest_access_ttl_seconds),
  defaultDownloadLimit:
    settings.default_download_limit === null ||
    settings.default_download_limit === undefined
      ? ""
      : String(settings.default_download_limit),
  maxUploadSizeMb: String(settings.max_upload_size_bytes / 1024 / 1024),
  allowGuestAccess: settings.allow_guest_access,
  requireOrderEmailMatch: settings.require_order_email_match,
  eventRetentionDays: String(settings.event_retention_days),
})

const optionalNumber = (value: string) =>
  value.trim() ? Number(value) : null

const DiagnosticInput = ({
  id,
  label,
  value,
}: {
  id: string
  label: string
  value?: string | null
}) => (
  <Field htmlFor={id} label={label}>
    <Input
      className="text-ui-fg-subtle"
      id={id}
      readOnly
      value={value || "Not configured"}
    />
  </Field>
)

const DigitalDownloadsSettingsPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsFormState | null>(null)
  const settingsQuery = useQuery({
    queryKey: digitalDownloadKeys.settings(),
    queryFn: () => digitalDownloadsApi.getSettings(),
  })

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(toFormState(settingsQuery.data))
    }
  }, [settingsQuery.data])

  const saveMutation = useMutation({
    mutationFn: (input: DigitalDownloadSettingsPatch) =>
      digitalDownloadsApi.updateSettings(input),
    onSuccess: async (settings) => {
      setForm(toFormState(settings))
      toast.success("Digital download settings saved.")
      await queryClient.invalidateQueries({
        queryKey: digitalDownloadKeys.settings(),
      })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const testMutation = useMutation({
    mutationFn: () => digitalDownloadsApi.testStorage(),
    onSuccess: (result) => {
      const issueSummary = result.issues.slice(0, 3).join(" · ")
      if (result.success) {
        toast.success(result.message || "Storage connection is working.")
      } else {
        toast.error(
          result.message || issueSummary || "Storage connection test failed."
        )
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  if (settingsQuery.isLoading) {
    return <LoadingState rows={8} />
  }

  if (settingsQuery.isError) {
    return (
      <ErrorState
        message={getErrorMessage(settingsQuery.error)}
        onRetry={() => void settingsQuery.refetch()}
        title="Settings could not be loaded"
      />
    )
  }

  if (!form || !settingsQuery.data) {
    return <LoadingState rows={8} />
  }

  const settings = settingsQuery.data
  const readiness = settings.readiness

  const update = <Key extends keyof SettingsFormState>(
    key: Key,
    value: SettingsFormState[Key]
  ) => setForm((current) => (current ? { ...current, [key]: value } : current))

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const defaultGrantTtlSeconds = Number(form.defaultGrantTtlSeconds)
    const maxGrantTtlSeconds = Number(form.maxGrantTtlSeconds)
    const guestAccessTtlSeconds = Number(form.guestAccessTtlSeconds)
    const maxUploadSizeMb = Number(form.maxUploadSizeMb)
    const eventRetentionDays = Number(form.eventRetentionDays)
    const defaultDownloadLimit = optionalNumber(form.defaultDownloadLimit)

    if (
      !Number.isInteger(defaultGrantTtlSeconds) ||
      defaultGrantTtlSeconds < 30 ||
      defaultGrantTtlSeconds > 86_400
    ) {
      toast.error("Signed link lifetime must be between 30 and 86,400 seconds.")
      return
    }
    if (
      !Number.isInteger(maxGrantTtlSeconds) ||
      maxGrantTtlSeconds < defaultGrantTtlSeconds ||
      maxGrantTtlSeconds > 86_400
    ) {
      toast.error(
        "Maximum signed link lifetime must be at least the default and no more than 86,400 seconds."
      )
      return
    }
    if (
      !Number.isInteger(guestAccessTtlSeconds) ||
      guestAccessTtlSeconds < 86_400 ||
      guestAccessTtlSeconds > 31_536_000
    ) {
      toast.error(
        "Guest access lifetime must be between 86,400 and 31,536,000 seconds."
      )
      return
    }
    if (!Number.isFinite(maxUploadSizeMb) || maxUploadSizeMb <= 0 || maxUploadSizeMb > 5_120) {
      toast.error("Maximum upload size must be between 1 and 5,120 MB.")
      return
    }
    if (!Number.isInteger(eventRetentionDays) || eventRetentionDays < 1 || eventRetentionDays > 36_500) {
      toast.error("Event retention must be between 1 and 36,500 days.")
      return
    }
    if (
      defaultDownloadLimit !== null &&
      (!Number.isInteger(defaultDownloadLimit) ||
        defaultDownloadLimit < 0 ||
        defaultDownloadLimit > 1_000_000)
    ) {
      toast.error("Download limit must be blank or between 0 and 1,000,000.")
      return
    }

    saveMutation.mutate({
      enabled: form.enabled,
      default_delivery_type: form.defaultDeliveryType,
      default_grant_ttl_seconds: defaultGrantTtlSeconds,
      max_grant_ttl_seconds: maxGrantTtlSeconds,
      guest_access_ttl_seconds: guestAccessTtlSeconds,
      default_download_limit: defaultDownloadLimit,
      max_upload_size_bytes: Math.round(maxUploadSizeMb * 1024 * 1024),
      allow_guest_access: form.allowGuestAccess,
      require_order_email_match: form.requireOrderEmailMatch,
      event_retention_days: eventRetentionDays,
    })
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={save}>
      <PageHeader
        actions={
          <>
            <Button
              isLoading={testMutation.isPending}
              onClick={() => testMutation.mutate()}
              type="button"
              variant="secondary"
            >
              Test storage
            </Button>
            <Button isLoading={saveMutation.isPending} type="submit">
              Save settings
            </Button>
          </>
        }
        description="Manage fulfillment behavior and check safe storage readiness diagnostics."
        onBack={() => navigate("/digital-downloads")}
        title="Digital download settings"
      />

      <Container className="divide-y p-0">
        <div className="flex items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">Fulfillment behavior</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              These settings are persisted by the plugin and can be changed here.
            </Text>
          </div>
          <Badge color={form.enabled ? "green" : "grey"} size="xsmall">
            {form.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-2">
          <div className="flex items-start gap-3 md:col-span-2">
            <Checkbox
              checked={form.enabled}
              id="digital-downloads-enabled"
              onCheckedChange={(checked) => update("enabled", checked === true)}
            />
            <label className="cursor-pointer" htmlFor="digital-downloads-enabled">
              <Text size="small" weight="plus">
                Enable digital fulfillment
              </Text>
              <Text className="text-ui-fg-subtle" size="xsmall">
                Allows the plugin to issue entitlements when configured order events occur.
              </Text>
            </label>
          </div>

          <Field htmlFor="default-delivery-type" label="Default delivery type">
            <Select
              onValueChange={(value) =>
                update(
                  "defaultDeliveryType",
                  value as SettingsFormState["defaultDeliveryType"]
                )
              }
              value={form.defaultDeliveryType}
            >
              <Select.Trigger id="default-delivery-type">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="download">Download</Select.Item>
                <Select.Item value="stream">Protected stream</Select.Item>
                <Select.Item value="license">License</Select.Item>
                <Select.Item value="mixed">Download and license</Select.Item>
              </Select.Content>
            </Select>
          </Field>

          <Field
            htmlFor="default-download-limit"
            hint="Blank = unlimited; 0 disables downloads"
            label="Default download limit"
          >
            <Input
              id="default-download-limit"
              max={1_000_000}
              min={0}
              onChange={(event) => update("defaultDownloadLimit", event.target.value)}
              type="number"
              value={form.defaultDownloadLimit}
            />
          </Field>

          <Field htmlFor="default-grant-ttl" label="Signed link lifetime" required>
            <div className="relative">
              <Input
                id="default-grant-ttl"
                max={86_400}
                min={30}
                onChange={(event) =>
                  update("defaultGrantTtlSeconds", event.target.value)
                }
                required
                type="number"
                value={form.defaultGrantTtlSeconds}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                seconds
              </span>
            </div>
          </Field>

          <Field
            htmlFor="max-grant-ttl"
            hint="Upper bound for manually requested grants"
            label="Maximum signed link lifetime"
            required
          >
            <div className="relative">
              <Input
                id="max-grant-ttl"
                max={86_400}
                min={30}
                onChange={(event) => update("maxGrantTtlSeconds", event.target.value)}
                required
                type="number"
                value={form.maxGrantTtlSeconds}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                seconds
              </span>
            </div>
          </Field>

          <Field
            htmlFor="guest-access-ttl"
            hint="Lifetime of the guest purchase link sent after fulfillment; separate from signed asset links"
            label="Guest access lifetime"
            required
          >
            <div className="relative">
              <Input
                id="guest-access-ttl"
                max={31_536_000}
                min={86_400}
                onChange={(event) =>
                  update("guestAccessTtlSeconds", event.target.value)
                }
                required
                type="number"
                value={form.guestAccessTtlSeconds}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                seconds
              </span>
            </div>
          </Field>

          <Field htmlFor="upload-limit" label="Maximum upload size" required>
            <div className="relative">
              <Input
                id="upload-limit"
                max={5_120}
                min={1}
                onChange={(event) => update("maxUploadSizeMb", event.target.value)}
                required
                type="number"
                value={form.maxUploadSizeMb}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                MB
              </span>
            </div>
          </Field>

          <Field htmlFor="event-retention" label="Event retention" required>
            <div className="relative">
              <Input
                id="event-retention"
                max={36_500}
                min={1}
                onChange={(event) => update("eventRetentionDays", event.target.value)}
                required
                type="number"
                value={form.eventRetentionDays}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                days
              </span>
            </div>
          </Field>

          <div className="space-y-4 md:col-span-2">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                checked={form.allowGuestAccess}
                onCheckedChange={(checked) =>
                  update("allowGuestAccess", checked === true)
                }
              />
              <span>
                <Text size="small" weight="plus">
                  Allow guest order access
                </Text>
                <Text className="text-ui-fg-subtle" size="xsmall">
                  Guests can retrieve purchases with a scoped access token.
                </Text>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                checked={form.requireOrderEmailMatch}
                onCheckedChange={(checked) =>
                  update("requireOrderEmailMatch", checked === true)
                }
              />
              <span>
                <Text size="small" weight="plus">
                  Require order email match
                </Text>
                <Text className="text-ui-fg-subtle" size="xsmall">
                  Guest access must match the email attached to the order.
                </Text>
              </span>
            </label>
          </div>
        </div>
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">Deployment diagnostics</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              Storage configuration is owned by the server. This page exposes only safe readiness diagnostics.
            </Text>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge
              color={settings.storage.provider === "s3" ? "blue" : "grey"}
              size="xsmall"
            >
              {settings.storage.provider === "s3" ? <CloudSolid /> : <CircleStack />}
              {settings.storage.provider === "s3" ? "S3-compatible" : "Local disk"}
            </Badge>
            <Badge color={readiness?.ready ? "green" : "orange"} size="xsmall">
              {readiness?.ready ? "Ready" : "Needs configuration"}
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-2">
          <DiagnosticInput
            id="storage-provider"
            label="Provider"
            value={
              settings.storage.provider === "s3"
                ? "S3-compatible object storage"
                : "Local server storage"
            }
          />
          <DiagnosticInput
            id="storage-configuration"
            label="Storage configuration"
            value={settings.storage.configured ? "Configured" : "Not configured"}
          />

          <div className="md:col-span-2">
            <Field
              htmlFor="mime-types"
              hint="Configured in the plugin options"
              label="Allowed file types"
            >
              <Textarea
                className="text-ui-fg-subtle"
                id="mime-types"
                readOnly
                rows={Math.min(5, Math.max(2, settings.allowed_mime_types?.length ?? 2))}
                value={settings.allowed_mime_types?.join("\n") || "No MIME restrictions reported"}
              />
            </Field>
          </div>

          <DiagnosticInput
            id="streaming-capability"
            label="Protected streaming"
            value={settings.enable_streaming ? "Available" : "Unavailable"}
          />
          <DiagnosticInput
            id="default-expiry-runtime"
            label="Runtime access expiry"
            value={
              settings.default_expiry_days == null
                ? "No runtime default"
                : `${settings.default_expiry_days} days`
            }
          />
        </div>

        <div className="space-y-3 px-6 py-5">
          <div className="flex flex-wrap gap-2">
            <Badge
              color={readiness?.token_secret_configured ? "green" : "orange"}
              size="xsmall"
            >
              Token secret {readiness?.token_secret_configured ? "configured" : "missing"}
            </Badge>
            <Badge
              color={readiness?.encryption_key_configured ? "green" : "orange"}
              size="xsmall"
            >
              Encryption key {readiness?.encryption_key_configured ? "configured" : "missing"}
            </Badge>
            {settings.storage.provider === "local" ? (
              <Badge
                color={readiness?.local_signing_secret_configured ? "green" : "orange"}
                size="xsmall"
              >
                Local signing secret {readiness?.local_signing_secret_configured ? "configured" : "missing"}
              </Badge>
            ) : null}
          </div>
          {readiness?.issues.length ? (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle px-4 py-3">
              <Text size="small" weight="plus">
                Configuration issues
              </Text>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {readiness.issues.map((issue, index) => (
                  <li className="text-ui-fg-subtle txt-small" key={`${index}-${issue}`}>
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Text className="text-ui-fg-subtle" size="small">
              {readiness?.ready
                ? "All required runtime configuration is present."
                : `No detailed readiness issues were reported for ${humanize(settings.storage.provider)} storage.`}
            </Text>
          )}
        </div>
      </Container>

      <div className="flex justify-end gap-2 py-3">
        <Button onClick={() => navigate("/digital-downloads")} type="button" variant="secondary">
          Cancel
        </Button>
        <Button isLoading={saveMutation.isPending} type="submit">
          Save settings
        </Button>
      </div>
      <MakePayAttribution />
    </form>
  )
}

export default DigitalDownloadsSettingsPage
