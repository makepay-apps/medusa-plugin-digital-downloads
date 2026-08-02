"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { DigitalDownloadsClient } from "../client"
import {
  DigitalDownloadsError,
  normalizeDigitalDownloadsError,
} from "../errors"
import type {
  DigitalAccessGrant,
  DigitalEntitlement,
  DigitalEntitlementResponse,
  DigitalLibraryQuery,
  DigitalLibraryResponse,
  DigitalLicenseActivateRequest,
  DigitalLicenseActivateResponse,
  DigitalLicenseDeactivateRequest,
  DigitalLicenseDeactivateResponse,
  DigitalLicenseHeartbeatRequest,
  DigitalLicenseHeartbeatResponse,
  DigitalLicenseRevealRequest,
  DigitalLicenseRevealResponse,
  DigitalLicenseValidateRequest,
  DigitalLicenseValidateResponse,
  DigitalProductPreview,
  DigitalProductPreviewResponse,
  DigitalStorefrontAccess,
  DigitalStorefrontRequestOptions,
} from "../types"
import {
  useDigitalDownloadsClient,
  useDigitalDownloadsIdentityKey,
} from "./context"

export interface DigitalResourceState<T> {
  data?: T
  error?: DigitalDownloadsError
  isLoading: boolean
  isRefreshing: boolean
  refetch: () => Promise<void>
}

interface ResourceOptions<T> {
  enabled: boolean
  load: (signal: AbortSignal) => Promise<T>
  dependencies: readonly unknown[]
  initialData?: T
}

interface ResourceSnapshot<T> {
  key: symbol
  data?: T
  error?: DigitalDownloadsError
  isLoading: boolean
  isRefreshing: boolean
}

const useDigitalResource = <T>({
  enabled,
  load,
  dependencies,
  initialData,
}: ResourceOptions<T>): DigitalResourceState<T> => {
  const resourceKey = useMemo(
    () => Symbol("digital-downloads-resource"),
    // The caller supplies primitive/stable dependencies for its load function.
    [enabled, ...dependencies]
  )
  const [snapshot, setSnapshot] = useState<ResourceSnapshot<T>>(() => ({
    key: resourceKey,
    data: initialData,
    isLoading: enabled && initialData === undefined,
    isRefreshing: false,
  }))
  const dataRef = useRef<{ key: symbol; data?: T }>({
    key: resourceKey,
    data: initialData,
  })
  const activeController = useRef<AbortController>()
  const sequence = useRef(0)
  const mounted = useRef(true)

  // A changed key makes old identity-scoped state invisible during render,
  // before the effect for the replacement request has a chance to run.
  const currentSnapshot: ResourceSnapshot<T> =
    snapshot.key === resourceKey
      ? snapshot
      : {
          key: resourceKey,
          isLoading: enabled,
          isRefreshing: false,
        }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeController.current?.abort()
    }
  }, [])

  const execute = useCallback(async () => {
    const current = ++sequence.current
    activeController.current?.abort()

    if (!enabled) {
      dataRef.current = { key: resourceKey }
      setSnapshot({
        key: resourceKey,
        isLoading: false,
        isRefreshing: false,
      })
      return
    }

    const controller = new AbortController()
    activeController.current = controller
    const cachedData =
      dataRef.current.key === resourceKey ? dataRef.current.data : undefined
    setSnapshot({
      key: resourceKey,
      data: cachedData,
      isLoading: cachedData === undefined,
      isRefreshing: cachedData !== undefined,
    })

    try {
      const result = await load(controller.signal)
      if (mounted.current && current === sequence.current && !controller.signal.aborted) {
        dataRef.current = { key: resourceKey, data: result }
        setSnapshot({
          key: resourceKey,
          data: result,
          isLoading: false,
          isRefreshing: false,
        })
      }
    } catch (requestError) {
      if (mounted.current && current === sequence.current && !controller.signal.aborted) {
        const retainedData =
          dataRef.current.key === resourceKey ? dataRef.current.data : undefined
        setSnapshot({
          key: resourceKey,
          data: retainedData,
          error: normalizeDigitalDownloadsError(requestError),
          isLoading: false,
          isRefreshing: false,
        })
      }
    } finally {
      if (mounted.current && current === sequence.current) {
        setSnapshot((currentState) =>
          currentState.key === resourceKey
            ? {
                ...currentState,
                isLoading: false,
                isRefreshing: false,
              }
            : currentState
        )
      }
    }
  }, [enabled, resourceKey])

  useEffect(() => {
    void execute()
    return () => activeController.current?.abort()
  }, [execute])

  return {
    data: currentSnapshot.data,
    error: currentSnapshot.error,
    isLoading: currentSnapshot.isLoading,
    isRefreshing: currentSnapshot.isRefreshing,
    refetch: execute,
  }
}

const useDigitalActorKey = (
  access: DigitalStorefrontAccess | undefined,
  identityOverride: string | undefined,
  enabled: boolean
): string => {
  const customerIdentity = useDigitalDownloadsIdentityKey(identityOverride)
  const guestToken = access?.guest_token

  if (guestToken !== undefined) {
    if (typeof guestToken !== "string" || !guestToken.trim()) {
      throw new DigitalDownloadsError(
        "Digital Downloads guest_token must be a non-empty string.",
        { code: "invalid_argument" }
      )
    }
    return `guest:${guestToken}:${access?.guest_email?.trim().toLowerCase() ?? ""}`
  }

  if (!customerIdentity) {
    if (!enabled) {
      return "customer:disabled"
    }
    throw new DigitalDownloadsError(
      "Digital Downloads customer flows require identityKey. Pass it to DigitalDownloadsProvider or the hook and change it whenever the authenticated customer/session changes.",
      { code: "invalid_configuration" }
    )
  }

  return `customer:${customerIdentity}`
}

const stableQuery = (value: object | undefined): string => {
  if (!value) {
    return "{}"
  }

  return JSON.stringify(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

export interface UseDigitalProductPreviewOptions {
  variantId: string
  enabled?: boolean
  initialData?: DigitalProductPreviewResponse
  client?: DigitalDownloadsClient
}

export interface DigitalProductPreviewState
  extends DigitalResourceState<DigitalProductPreviewResponse> {
  product?: DigitalProductPreview
}

export const useDigitalProductPreview = ({
  variantId,
  enabled = true,
  initialData,
  client: clientOverride,
}: UseDigitalProductPreviewOptions): DigitalProductPreviewState => {
  const client = useDigitalDownloadsClient(clientOverride)
  const resource = useDigitalResource({
    enabled: enabled && Boolean(variantId),
    initialData,
    dependencies: [client, variantId],
    load: (signal) =>
      client.getProductPreview(variantId, {
        signal,
      }),
  })

  return { ...resource, product: resource.data?.product }
}

export interface UseDigitalLibraryOptions {
  query?: DigitalLibraryQuery
  access?: DigitalStorefrontAccess
  enabled?: boolean
  initialData?: DigitalLibraryResponse
  client?: DigitalDownloadsClient
  /** Required for customer access; change it whenever the authenticated actor changes. */
  identityKey?: string
}

export interface DigitalLibraryState extends DigitalResourceState<DigitalLibraryResponse> {
  entitlements: DigitalEntitlement[]
  count: number
}

export const useDigitalLibrary = ({
  query,
  access,
  enabled = true,
  initialData,
  client: clientOverride,
  identityKey: identityOverride,
}: UseDigitalLibraryOptions = {}): DigitalLibraryState => {
  const client = useDigitalDownloadsClient(clientOverride)
  const identityKey = useDigitalActorKey(access, identityOverride, enabled)
  const queryKey = stableQuery(query)
  const requestQuery = useMemo<DigitalLibraryQuery>(
    () => (queryKey === "{}" ? {} : Object.fromEntries(JSON.parse(queryKey))),
    [queryKey]
  )
  const resource = useDigitalResource({
    enabled,
    initialData,
    dependencies: [client, identityKey, queryKey],
    load: async (signal) => {
      if (access?.guest_token) {
        const { entitlement } = await client.getGuestAccess(
          { token: access.guest_token, email: access.guest_email },
          { signal }
        )
        const status = Array.isArray(requestQuery.status)
          ? requestQuery.status
          : requestQuery.status
            ? [requestQuery.status]
            : undefined
        const kind = Array.isArray(requestQuery.kind)
          ? requestQuery.kind
          : requestQuery.kind
            ? [requestQuery.kind]
            : undefined
        const search = requestQuery.q?.trim().toLocaleLowerCase()
        const matches =
          (!requestQuery.order_id || entitlement.order_id === requestQuery.order_id) &&
          (!status || status.includes(entitlement.status)) &&
          (!kind || kind.includes(entitlement.product.kind)) &&
          (!search ||
            entitlement.product.title.toLocaleLowerCase().includes(search) ||
            entitlement.product.variant_title?.toLocaleLowerCase().includes(search))
        const offset = Math.max(0, requestQuery.offset ?? 0)
        const limit = Math.max(0, requestQuery.limit ?? 20)

        return {
          entitlements: matches && offset === 0 && limit > 0 ? [entitlement] : [],
          count: matches ? 1 : 0,
          limit,
          offset,
        }
      }

      return client.listLibrary(requestQuery, { signal })
    },
  })

  return {
    ...resource,
    entitlements: resource.data?.entitlements ?? [],
    count: resource.data?.count ?? 0,
  }
}

export interface UseDigitalEntitlementOptions {
  entitlementId: string
  access?: DigitalStorefrontAccess
  enabled?: boolean
  initialData?: DigitalEntitlementResponse
  client?: DigitalDownloadsClient
  /** Required for customer access; guest access is scoped by its capability token. */
  identityKey?: string
}

export interface DigitalEntitlementState
  extends DigitalResourceState<DigitalEntitlementResponse> {
  entitlement?: DigitalEntitlement
}

export const useDigitalEntitlement = ({
  entitlementId,
  access,
  enabled = true,
  initialData,
  client: clientOverride,
  identityKey: identityOverride,
}: UseDigitalEntitlementOptions): DigitalEntitlementState => {
  const client = useDigitalDownloadsClient(clientOverride)
  const identityKey = useDigitalActorKey(
    access,
    identityOverride,
    enabled && Boolean(entitlementId)
  )
  const resource = useDigitalResource({
    enabled: enabled && Boolean(entitlementId),
    initialData,
    dependencies: [client, entitlementId, identityKey],
    load: async (signal) => {
      if (access?.guest_token) {
        const result = await client.getGuestAccess(
          { token: access.guest_token, email: access.guest_email },
          { signal }
        )
        if (result.entitlement.id !== entitlementId) {
          throw new DigitalDownloadsError("Digital entitlement not found.", {
            status: 404,
            code: "not_found",
          })
        }
        return result
      }

      return client.getEntitlement(entitlementId, { signal })
    },
  })

  return { ...resource, entitlement: resource.data?.entitlement }
}

export type DigitalEntitlementAction =
  | "download"
  | "stream"
  | "reveal-license"
  | "activate-license"
  | "deactivate-license"
  | "license-heartbeat"
  | "validate-license"

export interface DigitalEntitlementActionsState {
  pendingAction?: DigitalEntitlementAction
  error?: DigitalDownloadsError
  clearError: () => void
  requestDownload: (
    assetId: string,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalAccessGrant>
  requestStream: (
    assetId: string,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalAccessGrant>
  revealLicense: (
    input?: DigitalLicenseRevealRequest,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalLicenseRevealResponse>
  activateLicense: (
    input: DigitalLicenseActivateRequest,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalLicenseActivateResponse>
  deactivateLicense: (
    input: DigitalLicenseDeactivateRequest,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalLicenseDeactivateResponse>
  heartbeatLicense: (
    input: DigitalLicenseHeartbeatRequest,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalLicenseHeartbeatResponse>
  validateLicense: (
    input: DigitalLicenseValidateRequest,
    options?: DigitalStorefrontRequestOptions
  ) => Promise<DigitalLicenseValidateResponse>
}

export interface UseDigitalEntitlementActionsOptions {
  entitlementId?: string
  licenseId?: string
  access?: DigitalStorefrontAccess
  client?: DigitalDownloadsClient
}

export const useDigitalEntitlementActions = ({
  entitlementId,
  licenseId,
  access,
  client: clientOverride,
}: UseDigitalEntitlementActionsOptions): DigitalEntitlementActionsState => {
  const client = useDigitalDownloadsClient(clientOverride)
  const [pendingAction, setPendingAction] = useState<DigitalEntitlementAction>()
  const [error, setError] = useState<DigitalDownloadsError>()
  const actionSequence = useRef(0)

  const invoke = useCallback(
    async <T,>(action: DigitalEntitlementAction, operation: () => Promise<T>): Promise<T> => {
      const current = ++actionSequence.current
      setPendingAction(action)
      setError(undefined)
      try {
        return await operation()
      } catch (requestError) {
        const normalized = normalizeDigitalDownloadsError(requestError)
        if (current === actionSequence.current) {
          setError(normalized)
        }
        throw normalized
      } finally {
        if (current === actionSequence.current) {
          setPendingAction(undefined)
        }
      }
    },
    []
  )

  const requireEntitlementId = useCallback((): string => {
    if (!entitlementId) {
      throw new DigitalDownloadsError(
        "entitlementId is required for access grants.",
        { code: "invalid_argument" }
      )
    }
    return entitlementId
  }, [entitlementId])

  const requireLicenseId = useCallback((): string => {
    if (!licenseId) {
      throw new DigitalDownloadsError("licenseId is required to reveal a license.", {
        code: "invalid_argument",
      })
    }
    return licenseId
  }, [licenseId])

  return useMemo(
    () => ({
      pendingAction,
      error,
      clearError: () => setError(undefined),
      requestDownload: (assetId, options) =>
        invoke("download", async () => {
          const currentEntitlementId = requireEntitlementId()
          const response = access?.guest_token
            ? await client.requestGuestAccessGrant(
                {
                  token: access.guest_token,
                  email: access.guest_email,
                  entitlement_id: currentEntitlementId,
                  asset_id: assetId,
                  action: "download",
                },
                options
              )
            : await client.requestDownloadGrant(
                currentEntitlementId,
                assetId,
                options
              )
          return response.grant
        }),
      requestStream: (assetId, options) =>
        invoke("stream", async () => {
          const currentEntitlementId = requireEntitlementId()
          const response = access?.guest_token
            ? await client.requestGuestAccessGrant(
                {
                  token: access.guest_token,
                  email: access.guest_email,
                  entitlement_id: currentEntitlementId,
                  asset_id: assetId,
                  action: "stream",
                },
                options
              )
            : await client.requestStreamGrant(
                currentEntitlementId,
                assetId,
                options
              )
          return response.grant
        }),
      revealLicense: (input = {}, options) =>
        invoke("reveal-license", () =>
          client.revealLicense(
            requireLicenseId(),
            {
              ...input,
              guest_token: input.guest_token ?? access?.guest_token,
              guest_email: input.guest_email ?? access?.guest_email,
            },
            options
          )
        ),
      activateLicense: (input, options) =>
        invoke("activate-license", () =>
          client.activateLicense(input, options)
        ),
      deactivateLicense: (input, options) =>
        invoke("deactivate-license", () =>
          client.deactivateLicense(input, options)
        ),
      heartbeatLicense: (input, options) =>
        invoke("license-heartbeat", () =>
          client.heartbeatLicense(input, options)
        ),
      validateLicense: (input, options) =>
        invoke("validate-license", () => client.validateLicense(input, options)),
    }),
    [
      access?.guest_token,
      access?.guest_email,
      client,
      error,
      invoke,
      pendingAction,
      requireEntitlementId,
      requireLicenseId,
    ]
  )
}

/** Alias focused on software-client integrations and license management UIs. */
export const useDigitalLicense = useDigitalEntitlementActions
