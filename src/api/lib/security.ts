import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { GrantTokenSchema } from "./validators.js"
import { apiError, sendApiError, unauthorized } from "./errors.js"

const processPrivacySalt = randomBytes(32)
const buckets = new Map<string, { count: number; resetAt: number }>()
const MAX_BUCKETS = 20_000

export type RateLimitOptions = {
  name: string
  limit: number
  windowMs: number
}

export function sha256Token(token: string, pepper?: string): string {
  const normalized = token.normalize("NFKC")
  return pepper
    ? createHmac("sha256", pepper).update(normalized).digest("hex")
    : createHash("sha256").update(normalized).digest("hex")
}

export function constantTimeDigestEqual(
  expectedDigest: string,
  candidateToken: string,
  pepper?: string,
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) return false
  const expected = Buffer.from(expectedDigest, "hex")
  const actual = Buffer.from(sha256Token(candidateToken, pepper), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function privacyHash(value: string | undefined): string | undefined {
  if (!value) return undefined
  const configured = process.env.DIGITAL_DOWNLOADS_PRIVACY_SALT
  const key = configured ? Buffer.from(configured, "utf8") : processPrivacySalt
  return createHmac("sha256", key).update(value).digest("hex")
}

export function clientContext(req: MedusaRequest) {
  return {
    ip_hash: privacyHash(req.ip),
    user_agent_hash: privacyHash(req.get("user-agent")),
    request_id: req.requestId,
  }
}

export function getIdempotencyKey(req: MedusaRequest): string | undefined {
  const value = req.get("idempotency-key")?.trim()
  if (!value) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(value)) {
    throw apiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 8-255 URL-safe characters.",
    )
  }
  return value
}

export function getBearerGrantToken(req: MedusaRequest): string {
  if ("token" in (req.query ?? {})) {
    throw apiError(
      400,
      "token_in_query_not_allowed",
      "Grant tokens must be sent in the Authorization header.",
    )
  }

  const authorization = req.get("authorization")
  if (!authorization) throw unauthorized("A download grant is required.")
  const match = /^Bearer ([^\s]+)$/i.exec(authorization)
  if (!match) throw unauthorized("Use Authorization: Bearer <grant>.")
  return GrantTokenSchema.parse(match[1])
}

function localConsume(key: string, options: RateLimitOptions) {
  const now = Date.now()
  if (buckets.size >= MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey)
    }
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined
      if (oldest) buckets.delete(oldest)
    }
  }

  const current = buckets.get(key)
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current
  bucket.count += 1
  buckets.set(key, bucket)

  return {
    allowed: bucket.count <= options.limit,
    remaining: Math.max(0, options.limit - bucket.count),
    resetAt: bucket.resetAt,
  }
}

async function distributedConsume(
  req: MedusaRequest,
  key: string,
  options: RateLimitOptions,
): Promise<{ allowed: boolean; remaining?: number; resetAt?: number } | undefined> {
  let limiter: Record<string, unknown> | undefined
  for (const registration of [
    "digitalDownloadsRateLimiter",
    "rateLimiter",
    "distributedRateLimiter",
  ]) {
    try {
      limiter = req.scope.resolve(registration) as Record<string, unknown>
      if (limiter) break
    } catch {
      // Optional integrations are resolved in priority order.
    }
  }
  if (!limiter) return undefined

  for (const methodName of ["consume", "check", "consumeRateLimit"]) {
    const method = limiter[methodName]
    if (typeof method !== "function") continue
    const result = await method.call(limiter, {
      key,
      limit: options.limit,
      window_ms: options.windowMs,
      namespace: `digital-downloads:${options.name}`,
    })
    if (typeof result === "boolean") return { allowed: result }
    if (result && typeof result === "object") {
      const value = result as Record<string, unknown>
      return {
        allowed: value.allowed !== false && value.success !== false,
        remaining:
          typeof value.remaining === "number" ? value.remaining : undefined,
        resetAt:
          typeof value.reset_at === "number"
            ? value.reset_at
            : typeof value.resetAt === "number"
              ? value.resetAt
              : undefined,
      }
    }
  }
  return undefined
}

export function rateLimit(options: RateLimitOptions) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction,
  ): Promise<void> => {
    try {
      const actor = (
        req as MedusaRequest & { auth_context?: { actor_id?: string } }
      ).auth_context?.actor_id
      const network = privacyHash(req.ip) ?? "unknown"
      const key = `${options.name}:${actor ?? network}`
      const result =
        (await distributedConsume(req, key, options)) ??
        localConsume(key, options)

      if (typeof result.remaining === "number") {
        res.setHeader("X-RateLimit-Remaining", String(result.remaining))
      }
      if (typeof result.resetAt === "number") {
        res.setHeader(
          "X-RateLimit-Reset",
          String(Math.ceil(result.resetAt / 1000)),
        )
      }
      if (!result.allowed) {
        const retryAfter = Math.max(
          1,
          Math.ceil(((result.resetAt ?? Date.now() + options.windowMs) - Date.now()) / 1000),
        )
        res.setHeader("Retry-After", String(retryAfter))
        throw apiError(429, "rate_limit_exceeded", "Too many requests.")
      }
      next()
    } catch (error) {
      sendApiError(res, error)
    }
  }
}

export function resetLocalRateLimitsForTests(): void {
  buckets.clear()
}
