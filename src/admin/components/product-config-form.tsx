import { useQuery } from "@tanstack/react-query"
import {
  Button,
  Checkbox,
  Container,
  Heading,
  Input,
  Select,
  Text,
  Textarea,
} from "@medusajs/ui"
import { type FormEvent, useEffect, useMemo, useState } from "react"

import { getErrorMessage } from "../lib/format"
import { digitalDownloadKeys } from "../lib/query-keys"
import { digitalDownloadsApi } from "../lib/sdk"
import type {
  DeliveryType,
  DigitalProductStatus,
  FulfillmentStrategy,
  ProductConfig,
  ProductConfigInput,
} from "../types/digital-downloads"
import { ErrorState, LoadingState } from "./feedback-state"
import { Field } from "./field"

interface ProductConfigFormProps {
  initial?: ProductConfig
  defaultProductId?: string
  isSubmitting?: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: (input: ProductConfigInput) => Promise<void> | void
}

interface FormState {
  productId: string
  title: string
  description: string
  status: DigitalProductStatus
  deliveryType: DeliveryType
  fulfillmentStrategy: FulfillmentStrategy
  variantIds: string[]
  licensePolicyId: string
  downloadLimit: string
  expiresInDays: string
}

const initialState = (
  initial?: ProductConfig,
  defaultProductId?: string
): FormState => ({
  productId: initial?.product_id ?? defaultProductId ?? "",
  title: initial?.title ?? "",
  description: initial?.description ?? "",
  status: initial?.status ?? "draft",
  deliveryType: initial?.delivery_type ?? "download",
  fulfillmentStrategy: initial?.fulfillment_strategy ?? "payment_captured",
  variantIds: initial?.variant_ids ?? initial?.variants?.map((variant) => variant.id) ?? [],
  licensePolicyId: initial?.license_policy_id ?? "",
  downloadLimit:
    initial?.download_limit === null || initial?.download_limit === undefined
      ? ""
      : String(initial.download_limit),
  expiresInDays:
    initial?.expires_in_days === null || initial?.expires_in_days === undefined
      ? ""
      : String(initial.expires_in_days),
})

const optionalPositiveNumber = (value: string) => {
  if (!value.trim()) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export const ProductConfigForm = ({
  initial,
  defaultProductId,
  isSubmitting = false,
  submitLabel,
  onCancel,
  onSubmit,
}: ProductConfigFormProps) => {
  const [form, setForm] = useState(() => initialState(initial, defaultProductId))
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setForm(initialState(initial, defaultProductId))
  }, [defaultProductId, initial])

  const productsQuery = useQuery({
    queryKey: digitalDownloadKeys.products(),
    queryFn: () => digitalDownloadsApi.listProducts(),
  })

  const selectedProduct = useMemo(
    () => productsQuery.data?.find((product) => product.id === form.productId),
    [form.productId, productsQuery.data]
  )

  const update = <Key extends keyof FormState>(key: Key, value: FormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setValidationError(null)

    if (!form.productId || !form.title.trim()) {
      setValidationError("Choose a product and enter a configuration title.")
      return
    }

    if (!form.variantIds.length) {
      setValidationError("Select at least one product variant.")
      return
    }

    if (
      (form.deliveryType === "license" ||
        form.deliveryType === "mixed" ||
        form.deliveryType === "download_and_license") &&
      !form.licensePolicyId
    ) {
      setValidationError("A license policy is required for licensed delivery.")
      return
    }

    try {
      await onSubmit({
        product_id: form.productId,
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        delivery_type: form.deliveryType,
        fulfillment_strategy: form.fulfillmentStrategy,
        variant_ids: form.variantIds,
        license_policy_id: form.licensePolicyId || null,
        download_limit: optionalPositiveNumber(form.downloadLimit),
        expires_in_days: optionalPositiveNumber(form.expiresInDays),
      })
    } catch (error) {
      setValidationError(getErrorMessage(error))
    }
  }

  if (productsQuery.isLoading) {
    return <LoadingState rows={6} />
  }

  if (productsQuery.isError) {
    return (
      <ErrorState
        message={getErrorMessage(productsQuery.error)}
        onRetry={() => void productsQuery.refetch()}
        title="Products could not be loaded"
      />
    )
  }

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      {validationError ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-ui-border-error bg-ui-bg-base px-4 py-3"
        >
          <Text className="text-ui-fg-error" size="small">
            {validationError}
          </Text>
        </div>
      ) : null}

      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Product association</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Choose which Medusa variants deliver this digital product.
          </Text>
        </div>
        <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-2">
          <Field htmlFor="digital-product" label="Product" required>
            <Select
              disabled={Boolean(initial)}
              onValueChange={(productId) => {
                const product = productsQuery.data?.find((item) => item.id === productId)
                setForm((current) => ({
                  ...current,
                  productId,
                  variantIds: product?.variants.map((variant) => variant.id) ?? [],
                  title: current.title || product?.title || "",
                }))
              }}
              value={form.productId}
            >
              <Select.Trigger id="digital-product">
                <Select.Value placeholder="Choose a product" />
              </Select.Trigger>
              <Select.Content>
                {productsQuery.data?.map((product) => (
                  <Select.Item key={product.id} value={product.id}>
                    {product.title}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </Field>
          <Field htmlFor="config-title" label="Configuration title" required>
            <Input
              id="config-title"
              onChange={(event) => update("title", event.target.value)}
              placeholder="Digital edition"
              value={form.title}
            />
          </Field>
          <div className="md:col-span-2">
            <Field htmlFor="config-description" label="Internal description">
              <Textarea
                id="config-description"
                onChange={(event) => update("description", event.target.value)}
                placeholder="Notes for your team; customers will not see this."
                rows={3}
                value={form.description}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Text className="mb-2 text-ui-fg-subtle" size="small" weight="plus">
              Variants
            </Text>
            {selectedProduct?.variants.length ? (
              <div className="grid grid-cols-1 gap-2 rounded-lg border border-ui-border-base p-3 md:grid-cols-2">
                {selectedProduct.variants.map((variant) => {
                  const checked = form.variantIds.includes(variant.id)
                  return (
                    <label
                      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-ui-bg-subtle"
                      key={variant.id}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          update(
                            "variantIds",
                            next === true
                              ? [...form.variantIds, variant.id]
                              : form.variantIds.filter((id) => id !== variant.id)
                          )
                        }
                      />
                      <span className="min-w-0">
                        <Text size="small" weight="plus">
                          {variant.title || "Default variant"}
                        </Text>
                        <Text className="text-ui-fg-muted" size="xsmall">
                          {variant.sku || variant.id}
                        </Text>
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : (
              <Text className="rounded-lg border border-ui-border-base p-3 text-ui-fg-muted" size="small">
                Choose a product to load its variants.
              </Text>
            )}
          </div>
        </div>
      </Container>

      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Delivery and access</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Define how orders are fulfilled and when customer access ends.
          </Text>
        </div>
        <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-2">
          <Field htmlFor="delivery-type" label="Delivery type">
            <Select
              onValueChange={(value) => update("deliveryType", value as DeliveryType)}
              value={form.deliveryType}
            >
              <Select.Trigger id="delivery-type">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="download">Protected download</Select.Item>
                <Select.Item value="license">License key</Select.Item>
                <Select.Item value="mixed">Download and license</Select.Item>
                <Select.Item value="stream">Protected stream</Select.Item>
              </Select.Content>
            </Select>
          </Field>
          <Field htmlFor="fulfillment" label="Fulfillment">
            <Select
              onValueChange={(value) =>
                update("fulfillmentStrategy", value as FulfillmentStrategy)
              }
              value={form.fulfillmentStrategy}
            >
              <Select.Trigger id="fulfillment">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="payment_captured">After payment is captured</Select.Item>
                <Select.Item value="order_completed">After order is completed</Select.Item>
                <Select.Item value="manual">Manual approval</Select.Item>
              </Select.Content>
            </Select>
          </Field>
          <Field htmlFor="download-limit" hint="Blank = unlimited" label="Download limit">
            <Input
              id="download-limit"
              min={0}
              onChange={(event) => update("downloadLimit", event.target.value)}
              placeholder="5"
              type="number"
              value={form.downloadLimit}
            />
          </Field>
          <Field htmlFor="expiry-days" hint="Blank = never" label="Access expires after">
            <div className="relative">
              <Input
                id="expiry-days"
                min={0}
                onChange={(event) => update("expiresInDays", event.target.value)}
                placeholder="365"
                type="number"
                value={form.expiresInDays}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ui-fg-muted txt-small">
                days
              </span>
            </div>
          </Field>
          {form.deliveryType === "license" ||
          form.deliveryType === "mixed" ||
          form.deliveryType === "download_and_license" ? (
            <div className="md:col-span-2">
              <Field
                htmlFor="license-policy"
                hint="Create policies in the API or settings"
                label="License policy ID"
                required
              >
                <Input
                  id="license-policy"
                  onChange={(event) => update("licensePolicyId", event.target.value)}
                  placeholder="lpol_..."
                  value={form.licensePolicyId}
                />
              </Field>
            </div>
          ) : null}
          <Field htmlFor="config-status" label="Status">
            <Select
              onValueChange={(value) => update("status", value as DigitalProductStatus)}
              value={form.status}
            >
              <Select.Trigger id="config-status">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="draft">Draft</Select.Item>
                <Select.Item value="active">Active</Select.Item>
                <Select.Item value="archived">Archived</Select.Item>
              </Select.Content>
            </Select>
          </Field>
        </div>
      </Container>

      <div className="flex justify-end gap-2 py-3">
        <Button onClick={onCancel} type="button" variant="secondary">
          Cancel
        </Button>
        <Button isLoading={isSubmitting} type="submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
