export const formatBytes = (bytes?: number | null) => {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) {
    return "—"
  }

  if (bytes === 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB", "TB"]
  const unit = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** unit

  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export const formatDate = (value?: string | null) => {
  if (!value) {
    return "—"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "—"
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed)
}

export const humanize = (value?: string | null) => {
  if (!value) {
    return "—"
  }

  return value
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (character: string) => character.toUpperCase())
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  return "An unexpected error occurred."
}
