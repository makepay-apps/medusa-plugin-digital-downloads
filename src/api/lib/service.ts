import type { MedusaRequest } from "@medusajs/framework/http"

import { DIGITAL_DOWNLOADS_SERVICE } from "./constants.js"
import { apiError, notFound, serviceUnavailable } from "./errors.js"

export type DigitalDownloadsServiceLike = Record<string, unknown>

export type Page<T = unknown> = {
  items: T[]
  count: number
  limit: number
  offset: number
}

export function resolveDigitalDownloadsService(
  req: Pick<MedusaRequest, "scope">,
): DigitalDownloadsServiceLike {
  try {
    return req.scope.resolve(DIGITAL_DOWNLOADS_SERVICE)
  } catch {
    throw serviceUnavailable()
  }
}

function methodOf(
  service: DigitalDownloadsServiceLike,
  names: readonly string[],
): ((...args: unknown[]) => unknown) | undefined {
  for (const name of names) {
    const method = service[name]
    if (typeof method === "function") {
      return method.bind(service) as (...args: unknown[]) => unknown
    }
  }
  return undefined
}

export function hasServiceMethod(
  service: DigitalDownloadsServiceLike,
  names: readonly string[],
): boolean {
  return Boolean(methodOf(service, names))
}

export async function invokeService<T = unknown>(
  service: DigitalDownloadsServiceLike,
  names: readonly string[],
  ...args: unknown[]
): Promise<T> {
  const method = methodOf(service, names)
  if (!method) {
    throw apiError(
      501,
      "capability_not_available",
      `The configured Digital Downloads service does not implement ${names[0]}.`,
    )
  }
  return (await method(...args)) as T
}

function arrayFromResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    if (Array.isArray(result[0]) && typeof result[1] === "number") {
      return result[0] as T[]
    }
    return result as T[]
  }
  if (!result || typeof result !== "object") return []
  const source = result as Record<string, unknown>
  for (const key of [
    "items",
    "data",
    "rows",
    "results",
    "product_configs",
    "releases",
    "assets",
    "license_policies",
    "license_pools",
    "entitlements",
    "downloads",
    "audit_events",
  ]) {
    if (Array.isArray(source[key])) return source[key] as T[]
  }
  return []
}

function countFromResult(result: unknown, fallback: number): number {
  if (Array.isArray(result) && typeof result[1] === "number") return result[1]
  if (!result || typeof result !== "object") return fallback
  const source = result as Record<string, unknown>
  for (const key of ["count", "total", "total_count"]) {
    if (typeof source[key] === "number") return source[key]
  }
  return fallback
}

export async function listService<T = unknown>(
  service: DigitalDownloadsServiceLike,
  names: readonly string[],
  filters: Record<string, unknown>,
  pagination: { limit: number; offset: number; order?: string },
  relations?: string[],
): Promise<Page<T>> {
  const order = pagination.order
    ? Object.fromEntries(
        pagination.order
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => /^-?[A-Za-z][A-Za-z0-9_]*$/.test(entry))
          .map((entry) => [
            entry.startsWith("-") ? entry.slice(1) : entry,
            entry.startsWith("-") ? "DESC" : "ASC",
          ]),
      )
    : undefined
  const result = await invokeService<unknown>(
    service,
    names,
    filters,
    {
      skip: pagination.offset,
      take: pagination.limit,
      offset: pagination.offset,
      limit: pagination.limit,
      ...(order && Object.keys(order).length ? { order } : {}),
      ...(relations ? { relations } : {}),
    },
  )
  const items = arrayFromResult<T>(result)
  return {
    items,
    count: countFromResult(result, items.length),
    limit: pagination.limit,
    offset: pagination.offset,
  }
}

export async function retrieveService<T = unknown>(
  service: DigitalDownloadsServiceLike,
  names: readonly string[],
  id: string,
  relations?: string[],
): Promise<T> {
  const result = await invokeService<T | null | undefined>(
    service,
    names,
    id,
    relations ? { relations } : undefined,
  )
  if (!result) throw notFound()
  return result
}

export function filtersWithoutPagination(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { limit: _limit, offset: _offset, order: _order, ...filters } = input
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  )
}

export function actorContext(req: MedusaRequest): Record<string, unknown> {
  const auth = (req as MedusaRequest & {
    auth_context?: { actor_id?: string; actor_type?: string }
  }).auth_context
  return {
    actor_id: auth?.actor_id,
    actor_type: auth?.actor_type,
    request_id: req.requestId,
  }
}

export function customerId(req: MedusaRequest): string {
  const actor = (
    req as MedusaRequest & { auth_context?: { actor_id?: string } }
  ).auth_context?.actor_id
  if (!actor) {
    throw apiError(401, "customer_authentication_required", "Sign in as a customer.")
  }
  return actor
}

export function assertOwnedByCustomer(
  value: unknown,
  expectedCustomerId: string,
): void {
  if (!value || typeof value !== "object") throw notFound()
  const owner = (value as Record<string, unknown>).customer_id
  if (typeof owner !== "string" || owner !== expectedCustomerId) {
    throw notFound()
  }
}

export function unwrapResult(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  for (const key of keys) {
    if (source[key] !== undefined) return source[key]
  }
  return value
}
