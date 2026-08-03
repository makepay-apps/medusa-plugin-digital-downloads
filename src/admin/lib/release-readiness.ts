import type {
  DeliveryType,
  DigitalRelease,
  LicensePolicy,
} from "../types/digital-downloads"

const enabledReadyAssets = (release: DigitalRelease) =>
  (release.assets ?? []).filter(
    (asset) => asset.is_enabled !== false && asset.status === "ready"
  )

export const hasPublishableReleaseDeliverables = ({
  deliveryType,
  licensePolicy,
  release,
}: {
  deliveryType: DeliveryType
  licensePolicy?: LicensePolicy | null
  release: DigitalRelease
}): boolean => {
  const assets = enabledReadyAssets(release)
  const roles = new Set(assets.map((asset) => asset.role))
  const hasDownload = roles.has("download") || roles.has("manual")
  const hasStream =
    roles.has("stream") ||
    assets.some(
      (asset) =>
        asset.delivery_type === "stream" || asset.delivery_type === "mixed"
    )
  const licenseStrategy = String(
    licensePolicy?.strategy ?? licensePolicy?.type ?? "none"
  ).toLowerCase()
  const hasLicense =
    licensePolicy?.is_enabled === true &&
    ["generated", "pool"].includes(licenseStrategy)

  const normalizedDeliveryType =
    deliveryType === "download_and_license" ? "mixed" : deliveryType
  if (normalizedDeliveryType === "license") return hasLicense
  if (normalizedDeliveryType === "stream") return hasStream
  if (normalizedDeliveryType === "mixed") {
    return (hasDownload || hasStream) && hasLicense
  }
  return hasDownload
}
