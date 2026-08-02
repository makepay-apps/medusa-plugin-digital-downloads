import { CloudArrowUp, XMark } from "@medusajs/icons"
import { Button, Heading, Select, Text, toast } from "@medusajs/ui"
import { useId, useRef, useState } from "react"

import { getErrorMessage } from "../lib/format"
import { digitalDownloadsApi, uploadToIntent } from "../lib/sdk"
import type {
  DigitalAsset,
  UploadProgress,
  UploadPurpose,
} from "../types/digital-downloads"

const PURPOSE_OPTIONS: Array<{
  value: UploadPurpose
  label: string
  description: string
}> = [
  {
    value: "download",
    label: "Customer download",
    description: "Protected file delivered to entitled customers.",
  },
  {
    value: "stream",
    label: "Protected stream",
    description: "Media delivered with protected byte-range streaming.",
  },
  {
    value: "preview",
    label: "Public preview",
    description: "Public sample that can be viewed before purchase.",
  },
  {
    value: "cover",
    label: "Cover artwork",
    description: "Public cover image for the digital release.",
  },
  {
    value: "manual",
    label: "Product manual",
    description: "Protected documentation delivered with the product.",
  },
  {
    value: "license",
    label: "License file",
    description: "Protected license material delivered after purchase.",
  },
]

interface UploadPanelProps {
  releaseId: string
  storageProvider?: string
  maxSizeMb?: number
  allowedMimeTypes?: string[]
  onComplete?: (assets: DigitalAsset[]) => void
}

export const UploadPanel = ({
  releaseId,
  storageProvider,
  maxSizeMb,
  allowedMimeTypes,
  onComplete,
}: UploadPanelProps) => {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [isUploading, setIsUploading] = useState(false)

  const validateFile = (file: File) => {
    if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
      return `${file.name} exceeds the ${maxSizeMb} MB upload limit.`
    }

    const fileMimeType = (file.type || "application/octet-stream").toLowerCase()
    const mimeTypeAllowed = allowedMimeTypes?.some((configured) => {
      const pattern = configured.trim().toLowerCase()
      return (
        pattern === "*" ||
        pattern === "*/*" ||
        pattern === fileMimeType ||
        (pattern.endsWith("/*") &&
          fileMimeType.startsWith(`${pattern.slice(0, -1)}`))
      )
    })

    if (allowedMimeTypes?.length && !mimeTypeAllowed) {
      return `${file.name} has an unsupported file type.`
    }

    return null
  }

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files)
    const invalid = next.map(validateFile).filter(Boolean) as string[]
    if (invalid.length) {
      toast.error(invalid[0])
    }

    const valid = next.filter((file) => !validateFile(file))
    setUploads((current) => [
      ...current,
      ...valid.map((file) => ({
        file,
        purpose: "download" as const,
        percent: 0,
        state: "queued" as const,
      })),
    ])
  }

  const updateUpload = (file: File, update: Partial<UploadProgress>) => {
    setUploads((current) =>
      current.map((item) => (item.file === file ? { ...item, ...update } : item))
    )
  }

  const uploadAll = async () => {
    const queued = uploads.filter(
      (upload) => upload.state === "queued" || upload.state === "error"
    )
    if (!queued.length) {
      return
    }

    setIsUploading(true)
    const completed: DigitalAsset[] = []

    for (const upload of queued) {
      try {
        updateUpload(upload.file, {
          state: "uploading",
          percent: 0,
          error: undefined,
        })
        const intent = await digitalDownloadsApi.createUploadIntent(
          upload.file,
          releaseId,
          upload.purpose,
          storageProvider
        )
        await uploadToIntent(intent, upload.file, (percent) =>
          updateUpload(upload.file, { percent })
        )
        const asset = await digitalDownloadsApi.completeUpload(
          intent.id,
          releaseId,
          upload.purpose
        )
        completed.push(asset)
        updateUpload(upload.file, { state: "complete", percent: 100, asset })
      } catch (error) {
        updateUpload(upload.file, {
          state: "error",
          error: getErrorMessage(error),
        })
      }
    }

    setIsUploading(false)
    if (completed.length) {
      toast.success(
        `${completed.length} ${completed.length === 1 ? "file" : "files"} uploaded.`
      )
      onComplete?.(completed)
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-ui-border-base bg-ui-bg-subtle px-6 py-8 text-center hover:border-ui-border-strong"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          addFiles(event.dataTransfer.files)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
      >
        <CloudArrowUp className="mb-2 text-ui-fg-muted" />
        <Heading level="h3">Drop files here or choose files</Heading>
        <Text className="mt-1 text-ui-fg-subtle" size="small">
          Uploads are protected and never expose their storage key to customers.
        </Text>
        <input
          accept={allowedMimeTypes?.join(",")}
          className="sr-only"
          id={inputId}
          multiple
          onChange={(event) => {
            if (event.target.files) {
              addFiles(event.target.files)
              event.target.value = ""
            }
          }}
          ref={inputRef}
          type="file"
        />
      </div>

      {uploads.length ? (
        <div className="divide-y rounded-lg border border-ui-border-base">
          {uploads.map((upload) => (
            <div
              className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center"
              key={`${upload.file.name}-${upload.file.lastModified}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <Text className="truncate" size="small" weight="plus">
                    {upload.file.name}
                  </Text>
                  <Text className="text-ui-fg-subtle" size="xsmall">
                    {upload.state === "error" ? "Failed" : `${upload.percent}%`}
                  </Text>
                </div>
                <div
                  aria-label={`${upload.file.name} upload progress`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={upload.percent}
                  className="mt-2 h-1 overflow-hidden rounded-full bg-ui-bg-component"
                  role="progressbar"
                >
                  <div
                    className={`h-full transition-all ${
                      upload.state === "error" ? "bg-ui-fg-error" : "bg-ui-fg-interactive"
                    }`}
                    style={{ width: `${upload.percent}%` }}
                  />
                </div>
                {upload.error ? (
                  <Text className="mt-1 text-ui-fg-error" size="xsmall">
                    {upload.error}
                  </Text>
                ) : null}
              </div>
              <div className="w-full md:w-56">
                <Select
                  disabled={upload.state === "uploading" || upload.state === "complete"}
                  onValueChange={(value) =>
                    updateUpload(upload.file, { purpose: value as UploadPurpose })
                  }
                  value={upload.purpose}
                >
                  <Select.Trigger aria-label={`Delivery role for ${upload.file.name}`}>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {PURPOSE_OPTIONS.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                <Text className="mt-1 text-ui-fg-muted" size="xsmall">
                  {
                    PURPOSE_OPTIONS.find(
                      (option) => option.value === upload.purpose
                    )?.description
                  }
                </Text>
              </div>
              {upload.state !== "uploading" ? (
                <Button
                  aria-label={`Remove ${upload.file.name}`}
                  onClick={() =>
                    setUploads((current) => current.filter((item) => item !== upload))
                  }
                  size="small"
                  variant="transparent"
                >
                  <XMark />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          disabled={!uploads.some((upload) => upload.state !== "complete")}
          isLoading={isUploading}
          onClick={uploadAll}
          type="button"
        >
          Upload files
        </Button>
      </div>
    </div>
  )
}
