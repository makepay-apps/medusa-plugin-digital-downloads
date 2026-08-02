"use client"

import {
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  fetchDigitalAccessGrant,
  type DigitalDownloadsClient,
} from "../client"
import { DigitalDownloadsError } from "../errors"
import type {
  DigitalAccessGrant,
  DigitalEntitlement,
  DigitalEntitlementAsset,
  DigitalLibraryQuery,
  DigitalLibraryResponse,
  DigitalLicenseRevealResponse,
  DigitalStorefrontAccess,
} from "../types"
import { MakePayAttribution } from "./attribution"
import {
  useDigitalEntitlementActions,
  useDigitalLibrary,
} from "./hooks"

const readableBytes = (bytes?: number | null): string | undefined => {
  if (bytes === undefined || bytes === null || bytes < 0) {
    return undefined
  }
  if (bytes < 1_000) {
    return `${bytes} B`
  }

  const units = ["kB", "MB", "GB", "TB"]
  let value = bytes / 1_000
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1_000; index += 1) {
    value /= 1_000
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

export const MAX_BROWSER_GRANT_BYTES = 64 * 1024 * 1024

const DOWNLOAD_MIME_TYPE = "application/octet-stream"
const INLINE_MEDIA_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
  "video/mp4",
  "video/ogg",
  "video/webm",
])
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

const unsafeGrant = (message: string, code: string): DigitalDownloadsError =>
  new DigitalDownloadsError(message, { code })

const declaredLength = (
  value: number | null | undefined,
  label: string
): number | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw unsafeGrant(`${label} is invalid.`, "invalid_content_length")
  }
  if (value > MAX_BROWSER_GRANT_BYTES) {
    throw unsafeGrant(
      "This asset is too large for the built-in browser opener. Use a streaming BFF or a custom grant handler.",
      "browser_content_too_large"
    )
  }
  return value
}

const responseLength = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw unsafeGrant("The content response length is invalid.", "invalid_content_length")
  }
  return declaredLength(Number(value), "The content response length")
}

const normalizedMimeType = (value: string | null | undefined): string | undefined => {
  if (value === undefined || value === null || !value.trim()) {
    return undefined
  }
  const normalized = value.toLowerCase().split(";", 1)[0].trim()
  if (!MIME_TYPE_PATTERN.test(normalized)) {
    throw unsafeGrant("The content response MIME type is invalid.", "invalid_content_type")
  }
  return normalized
}

export interface PreparedDigitalAccessGrant {
  blob: Blob
  openInline: boolean
  mimeType: string
  size: number
}

/**
 * Reads a protected response through a hard byte ceiling and converts it to a
 * non-executable download or a narrowly allowlisted native-media Blob.
 */
export const prepareDigitalAccessGrant = async (
  grant: DigitalAccessGrant,
  response: Response
): Promise<PreparedDigitalAccessGrant> => {
  const grantLength = declaredLength(grant.size_bytes, "The declared asset size")
  const headerLength = responseLength(response.headers.get("content-length"))
  if (grantLength !== undefined && headerLength !== undefined && grantLength !== headerLength) {
    throw unsafeGrant(
      "The protected content length does not match its grant.",
      "content_length_mismatch"
    )
  }

  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase()
  if (contentEncoding && contentEncoding !== "identity") {
    throw unsafeGrant(
      "Encoded protected responses are not supported by the built-in browser opener.",
      "unsupported_content_encoding"
    )
  }

  const responseMimeType = normalizedMimeType(response.headers.get("content-type"))
  const grantMimeType = normalizedMimeType(grant.mime_type)
  if (!responseMimeType) {
    throw unsafeGrant("The protected response is missing its MIME type.", "invalid_content_type")
  }
  if (grantMimeType && responseMimeType !== grantMimeType) {
    throw unsafeGrant(
      "The protected content MIME type does not match its grant.",
      "content_type_mismatch"
    )
  }

  const openInline = grant.action === "stream"
  if (openInline && !INLINE_MEDIA_MIME_TYPES.has(responseMimeType)) {
    throw unsafeGrant(
      "Only allowlisted audio and video formats can be opened inline.",
      "unsafe_inline_content_type"
    )
  }

  const chunks: BlobPart[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array)) {
          throw unsafeGrant(
            "The protected response returned an invalid byte stream.",
            "invalid_content_stream"
          )
        }
        size += value.byteLength
        if (!Number.isSafeInteger(size) || size > MAX_BROWSER_GRANT_BYTES) {
          throw unsafeGrant(
            "This asset is too large for the built-in browser opener. Use a streaming BFF or a custom grant handler.",
            "browser_content_too_large"
          )
        }
        const ownedChunk = new Uint8Array(value.byteLength)
        ownedChunk.set(value)
        chunks.push(ownedChunk)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  if (
    (grantLength !== undefined && size !== grantLength) ||
    (headerLength !== undefined && size !== headerLength)
  ) {
    throw unsafeGrant(
      "The protected response ended at an unexpected byte length.",
      "content_length_mismatch"
    )
  }

  const mimeType = openInline ? responseMimeType : DOWNLOAD_MIME_TYPE
  return {
    blob: new Blob(chunks, { type: mimeType }),
    openInline,
    mimeType,
    size,
  }
}

const openGrant = async (grant: DigitalAccessGrant): Promise<void> => {
  if (typeof document === "undefined") {
    return
  }

  const response = await fetchDigitalAccessGrant(grant)
  const { blob, openInline } = await prepareDigitalAccessGrant(grant, response)
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.rel = "noopener noreferrer"
  if (openInline) {
    link.target = "_blank"
  } else {
    link.download = grant.filename?.trim() || "download"
  }
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

export interface DigitalEntitlementCardProps {
  entitlement: DigitalEntitlement
  access?: DigitalStorefrontAccess
  client?: DigitalDownloadsClient
  className?: string
  onGrant?: (
    grant: DigitalAccessGrant,
    entitlement: DigitalEntitlement,
    asset: DigitalEntitlementAsset
  ) => void | Promise<void>
  onLicenseRevealed?: (
    result: DigitalLicenseRevealResponse,
    entitlement: DigitalEntitlement
  ) => void
}

/** Buyer-facing entitlement primitive with keyboard-native actions. */
export const DigitalEntitlementCard = ({
  entitlement,
  access,
  client,
  className,
  onGrant,
  onLicenseRevealed,
}: DigitalEntitlementCardProps) => {
  const titleId = useId()
  const [revealedKey, setRevealedKey] = useState<string>()
  const [interactionError, setInteractionError] = useState<string>()
  const actions = useDigitalEntitlementActions({
    entitlementId: entitlement.id,
    licenseId: entitlement.license?.id,
    access,
    client,
  })
  const active = entitlement.status === "active"

  const handleGrant = async (
    event: MouseEvent<HTMLButtonElement>,
    asset: DigitalEntitlementAsset,
    action: "download" | "stream"
  ) => {
    event.preventDefault()
    setInteractionError(undefined)
    try {
      const grant =
        action === "download"
          ? await actions.requestDownload(asset.id)
          : await actions.requestStream(asset.id)
      const resolvedGrant = {
        ...grant,
        filename: grant.filename ?? asset.filename,
        mime_type: grant.mime_type ?? asset.mime_type,
        size_bytes: grant.size_bytes ?? asset.size_bytes,
      }
      if (onGrant) {
        await onGrant(resolvedGrant, entitlement, asset)
      } else {
        await openGrant(resolvedGrant)
      }
    } catch (error) {
      if (!actions.error) {
        setInteractionError(
          error instanceof Error ? error.message : "Unable to open this digital asset."
        )
      }
    }
  }

  const handleReveal = async () => {
    if (revealedKey) {
      setRevealedKey(undefined)
      return
    }

    try {
      setInteractionError(undefined)
      const result = await actions.revealLicense()
      setRevealedKey(result.license_key)
      onLicenseRevealed?.(result, entitlement)
    } catch (error) {
      if (!actions.error) {
        setInteractionError(
          error instanceof Error ? error.message : "Unable to reveal this license."
        )
      }
    }
  }

  return (
    <article
      aria-labelledby={titleId}
      className={className}
      data-digital-entitlement={entitlement.id}
      data-status={entitlement.status}
    >
      <header>
        {entitlement.product.thumbnail ? (
          <img
            alt=""
            height={64}
            loading="lazy"
            src={entitlement.product.thumbnail}
            width={64}
          />
        ) : null}
        <div>
          <h3 id={titleId}>{entitlement.product.title}</h3>
          {entitlement.product.variant_title ? (
            <p>{entitlement.product.variant_title}</p>
          ) : null}
        </div>
        <span aria-label={`Entitlement status: ${entitlement.status}`}>
          {entitlement.status}
        </span>
      </header>

      <dl>
        <div>
          <dt>Order</dt>
          <dd>{entitlement.order_display_id ?? entitlement.order_id}</dd>
        </div>
        <div>
          <dt>Purchased</dt>
          <dd>
            <time dateTime={entitlement.granted_at ?? entitlement.created_at}>
              {new Date(
                entitlement.granted_at ?? entitlement.created_at
              ).toLocaleDateString()}
            </time>
          </dd>
        </div>
        {entitlement.expires_at ? (
          <div>
            <dt>Access expires</dt>
            <dd>
              <time dateTime={entitlement.expires_at}>
                {new Date(entitlement.expires_at).toLocaleDateString()}
              </time>
            </dd>
          </div>
        ) : null}
      </dl>

      {entitlement.status_reason && !active ? <p>{entitlement.status_reason}</p> : null}

      {entitlement.assets.length ? (
        <section aria-label={`Files for ${entitlement.product.title}`}>
          <ul>
            {entitlement.assets.map((asset) => {
              const size = readableBytes(asset.size_bytes)
              return (
                <li key={asset.id}>
                  <span>
                    <strong>{asset.title}</strong>
                    {size ? ` · ${size}` : ""}
                  </span>
                  {asset.delivery_types.includes("download") ? (
                    <button
                      disabled={
                        !active ||
                        !entitlement.capabilities.can_download ||
                        actions.pendingAction !== undefined
                      }
                      onClick={(event) => void handleGrant(event, asset, "download")}
                      type="button"
                    >
                      {actions.pendingAction === "download" ? "Preparing…" : "Download"}
                    </button>
                  ) : null}
                  {asset.delivery_types.includes("stream") ? (
                    <button
                      disabled={
                        !active ||
                        !entitlement.capabilities.can_stream ||
                        actions.pendingAction !== undefined
                      }
                      onClick={(event) => void handleGrant(event, asset, "stream")}
                      type="button"
                    >
                      {actions.pendingAction === "stream" ? "Preparing…" : "Play"}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {entitlement.license ? (
        <section aria-label={`License for ${entitlement.product.title}`}>
          <dl>
            <div>
              <dt>License</dt>
              <dd>{entitlement.license.masked_key ?? "Ready to reveal"}</dd>
            </div>
            <div>
              <dt>Activations</dt>
              <dd>
                {entitlement.license.activations.filter(
                  (activation) => activation.status === "active"
                ).length}
                {entitlement.license.max_activations !== null &&
                entitlement.license.max_activations !== undefined
                  ? ` of ${entitlement.license.max_activations}`
                  : ""}
              </dd>
            </div>
          </dl>
          {revealedKey ? (
            <p aria-live="polite">
              <span>License key: </span>
              <code>{revealedKey}</code>
            </p>
          ) : null}
          <button
            aria-expanded={Boolean(revealedKey)}
            disabled={
              !active ||
              !entitlement.capabilities.can_reveal_license ||
              actions.pendingAction !== undefined
            }
            onClick={() => void handleReveal()}
            type="button"
          >
            {actions.pendingAction === "reveal-license"
              ? "Revealing…"
              : revealedKey
                ? "Hide license key"
                : "Reveal license key"}
          </button>
        </section>
      ) : null}

      <div
        aria-live="polite"
        role={actions.error || interactionError ? "alert" : "status"}
      >
        {actions.error?.message ?? interactionError ?? ""}
      </div>
    </article>
  )
}

export interface DigitalLibraryProps {
  query?: DigitalLibraryQuery
  access?: DigitalStorefrontAccess
  client?: DigitalDownloadsClient
  /** Required for customer access unless supplied by DigitalDownloadsProvider. */
  identityKey?: string
  initialData?: DigitalLibraryResponse
  className?: string
  heading?: ReactNode
  empty?: ReactNode
  loading?: ReactNode
  showAttribution?: boolean
  renderEntitlement?: (
    entitlement: DigitalEntitlement,
    index: number
  ) => ReactNode
  onGrant?: DigitalEntitlementCardProps["onGrant"]
  onLicenseRevealed?: DigitalEntitlementCardProps["onLicenseRevealed"]
}

/** Fetches an authenticated-customer or guest-capability digital library. */
export const DigitalLibrary = ({
  query,
  access,
  client,
  identityKey,
  initialData,
  className,
  heading = "Your digital library",
  empty = "Your digital purchases will appear here.",
  loading = "Loading your digital library…",
  showAttribution = true,
  renderEntitlement,
  onGrant,
  onLicenseRevealed,
}: DigitalLibraryProps) => {
  const headingId = useId()
  const { entitlements, error, isLoading, isRefreshing, refetch } =
    useDigitalLibrary({ query, access, client, identityKey, initialData })

  return (
    <section
      aria-busy={isLoading || isRefreshing}
      aria-labelledby={headingId}
      className={className}
      data-digital-library=""
    >
      <header>
        <h2 id={headingId}>{heading}</h2>
        <button disabled={isLoading || isRefreshing} onClick={() => void refetch()} type="button">
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {isLoading ? (
        <p aria-live="polite" role="status">
          {loading}
        </p>
      ) : error ? (
        <div role="alert">
          <p>{error.message}</p>
          <button onClick={() => void refetch()} type="button">
            Try again
          </button>
        </div>
      ) : entitlements.length ? (
        <ul>
          {entitlements.map((entitlement, index) => (
            <li key={entitlement.id}>
              {renderEntitlement ? (
                renderEntitlement(entitlement, index)
              ) : (
                <DigitalEntitlementCard
                  access={access}
                  client={client}
                  entitlement={entitlement}
                  onGrant={onGrant}
                  onLicenseRevealed={onLicenseRevealed}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}

      {showAttribution ? <MakePayAttribution /> : null}
    </section>
  )
}
