export const digitalDownloadKeys = {
  all: ["digital-downloads"] as const,
  summary: () => [...digitalDownloadKeys.all, "summary"] as const,
  settings: () => [...digitalDownloadKeys.all, "settings"] as const,
  configs: (filters: unknown) =>
    [...digitalDownloadKeys.all, "product-configs", filters] as const,
  config: (id: string) =>
    [...digitalDownloadKeys.all, "product-config", id] as const,
  entitlements: (filters: unknown) =>
    [...digitalDownloadKeys.all, "entitlements", filters] as const,
  products: () => [...digitalDownloadKeys.all, "products"] as const,
  licensePolicies: (filters: unknown) =>
    [...digitalDownloadKeys.all, "license-policies", filters] as const,
  licenseKeys: (policyId: string, filters: unknown) =>
    [...digitalDownloadKeys.all, "license-policy", policyId, "keys", filters] as const,
}
