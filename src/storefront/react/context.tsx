"use client"

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react"
import type { DigitalDownloadsClient } from "../client"

interface DigitalDownloadsContextValue {
  client: DigitalDownloadsClient
  identityKey?: string
}

const DigitalDownloadsContext = createContext<DigitalDownloadsContextValue | null>(null)

const checkedIdentityKey = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      "Digital Downloads identityKey must be a non-empty string of at most 512 characters without control characters."
    )
  }
  return value
}

export interface DigitalDownloadsProviderProps extends PropsWithChildren {
  client: DigitalDownloadsClient
  /**
   * Non-secret customer/session identity. Change this value whenever the
   * authenticated storefront actor changes. Guest hooks derive their scope
   * from the guest capability instead.
   */
  identityKey?: string
}

/** Makes one configured client available to all storefront hooks. */
export const DigitalDownloadsProvider = ({
  client,
  identityKey,
  children,
}: DigitalDownloadsProviderProps) => {
  const value = useMemo<DigitalDownloadsContextValue>(
    () => ({ client, identityKey: checkedIdentityKey(identityKey) }),
    [client, identityKey]
  )

  return createElement(DigitalDownloadsContext.Provider, { value }, children)
}

export const useDigitalDownloadsClient = (
  override?: DigitalDownloadsClient
): DigitalDownloadsClient => {
  const configured = useContext(DigitalDownloadsContext)
  const client = override ?? configured?.client

  if (!client) {
    throw new Error(
      "Digital Downloads client is missing. Wrap this tree in DigitalDownloadsProvider or pass a client to the hook."
    )
  }

  return client
}

/** Returns the provider identity key or validates a hook-level override. */
export const useDigitalDownloadsIdentityKey = (
  override?: string
): string | undefined => {
  const configured = useContext(DigitalDownloadsContext)
  return checkedIdentityKey(override ?? configured?.identityKey)
}
