"use client"

import { useId, type ReactNode } from "react"
import type { DigitalDownloadsClient } from "../client"
import type {
  DigitalPreviewAsset,
  DigitalProductPreview,
} from "../types"
import { MakePayAttribution } from "./attribution"
import { useDigitalProductPreview } from "./hooks"

const defaultPreview = (preview: DigitalPreviewAsset): ReactNode => {
  if (!preview.url) {
    return (
      <div data-digital-preview-placeholder="">
        <strong>{preview.title}</strong>
        {preview.description ? <p>{preview.description}</p> : null}
      </div>
    )
  }

  if (preview.kind === "image" || preview.mime_type.startsWith("image/")) {
    return (
      <figure>
        <img
          alt={preview.alt ?? preview.title}
          height={preview.height ?? undefined}
          loading="lazy"
          src={preview.url}
          width={preview.width ?? undefined}
        />
        {preview.description ? <figcaption>{preview.description}</figcaption> : null}
      </figure>
    )
  }

  if (preview.kind === "audio" || preview.mime_type.startsWith("audio/")) {
    return (
      <figure>
        <figcaption>{preview.title}</figcaption>
        <audio aria-label={preview.title} controls preload="metadata" src={preview.url}>
          Your browser does not support audio previews.
        </audio>
      </figure>
    )
  }

  if (preview.kind === "video" || preview.mime_type.startsWith("video/")) {
    return (
      <figure>
        <figcaption>{preview.title}</figcaption>
        <video
          aria-label={preview.title}
          controls
          poster={preview.poster_url ?? undefined}
          preload="metadata"
          src={preview.url}
        >
          Your browser does not support video previews.
        </video>
      </figure>
    )
  }

  return (
    <a href={preview.url} rel="noopener noreferrer" target="_blank">
      Preview {preview.title}
      <span aria-hidden="true"> ↗</span>
    </a>
  )
}

export interface DigitalProductPreviewsProps {
  variantId: string
  client?: DigitalDownloadsClient
  className?: string
  heading?: ReactNode
  empty?: ReactNode
  loading?: ReactNode
  showAttribution?: boolean
  renderPreview?: (
    preview: DigitalPreviewAsset,
    product: DigitalProductPreview
  ) => ReactNode
}

/** Fetches and renders safe public samples without exposing protected assets. */
export const DigitalProductPreviews = ({
  variantId,
  client,
  className,
  heading = "Preview",
  empty = "No preview is available for this product.",
  loading = "Loading product previews…",
  showAttribution = true,
  renderPreview = defaultPreview,
}: DigitalProductPreviewsProps) => {
  const headingId = useId()
  const { product, error, isLoading } = useDigitalProductPreview({
    variantId,
    client,
  })

  if (isLoading) {
    return (
      <div aria-live="polite" className={className} role="status">
        {loading}
      </div>
    )
  }

  if (error) {
    return (
      <div className={className} role="alert">
        {error.message}
      </div>
    )
  }

  const previews = product?.previews ?? []

  return (
    <section
      aria-labelledby={headingId}
      className={className}
      data-digital-product-previews=""
    >
      <h2 id={headingId}>{heading}</h2>
      {previews.length ? (
        <ul>
          {previews.map((preview) => (
            <li key={preview.id}>{renderPreview(preview, product!)}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
      {showAttribution ? <MakePayAttribution /> : null}
    </section>
  )
}
