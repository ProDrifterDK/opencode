import { Effect, Layer, Context, Schema, Deferred, Schedule } from "effect"
import {
  RATE_LIMIT_TOKENS_PER_MIN,
  RATE_LIMIT_MAX_CONCURRENT,
  RATE_LIMIT_BASE_BACKOFF_MS,
} from "./constants"
import type { EngineerID } from "./types"

export class RateLimitExhaustedError extends Schema.TaggedErrorClass<RateLimitExhaustedError>()("RateLimitExhaustedError", {
  engineerID: Schema.String,
  retryAfterMs: Schema.Number,
}) {}

export class CircuitBreakerOpenError extends Schema.TaggedErrorClass<CircuitBreakerOpenError>()("CircuitBreakerOpenError", {
  engineerID: Schema.String,
  remainingMs: Schema.Number,
}) {}

export type Priority = "lead" | "engineer"

export interface PendingRequest {
  engineerID: EngineerID
  priority: Priority
  estimatedTokens: number
  deferred: Deferred.Deferred<void, RateLimitExhaustedError | CircuitBreakerOpenError>
  enqueuedAt: number
}

export interface RateLimiterStats {
  activeCalls: number
  queuedCalls: number
  tokensUsedThisMinute: number
  tokensBudgetPerMinute: number
  circuitBreakerOpen: boolean
  consecutive429s: number
}

export interface Interface {
  readonly acquire: (
    engineerID: EngineerID,
    priority: Priority,
    estimatedTokens: number,
  ) => Effect.Effect<void, RateLimitExhaustedError | CircuitBreakerOpenError>
  readonly release: (engineerID: EngineerID, tokensUsed: number) => Effect.Effect<void>
  readonly report429: (engineerID: EngineerID) => Effect.Effect<void>
  readonly resetCircuitBreaker: () => Effect.Effect<void>
  readonly getStats: () => RateLimiterStats
}

const PRIORITY_ORDER: Record<Priority, number> = {
  lead: 0,
  engineer: 1,
}

const MAX_BACKOFF_MS = 5 * 60 * 1000
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_BLOCK_MS = 5 * 60 * 1000

export class Service extends Context.Service<Service, Interface>()("@opencode/RateLimiter") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let activeCalls = 0
    let tokensUsedThisMinute = 0
    let consecutive429s = 0
    let circuitBreakerOpen = false
    let circuitBreakerOpenUntil = 0

    const queue: PendingRequest[] = []

    const minuteWindowStart = { value: Date.now() }

    const resetMinuteWindow = () => {
      const now = Date.now()
      if (now - minuteWindowStart.value >= 60_000) {
        tokensUsedThisMinute = 0
        minuteWindowStart.value = now
      }
    }

    const hasBudget = (tokens: number): boolean => {
      resetMinuteWindow()
      return tokensUsedThisMinute + tokens <= RATE_LIMIT_TOKENS_PER_MIN
    }

    const canProceed = (tokens: number): boolean =>
      activeCalls < RATE_LIMIT_MAX_CONCURRENT
      && hasBudget(tokens)
      && !isCircuitBreakerActive()

    const isCircuitBreakerActive = (): boolean => {
      if (!circuitBreakerOpen) return false
      if (Date.now() >= circuitBreakerOpenUntil) {
        circuitBreakerOpen = false
        consecutive429s = 0
        return false
      }
      return true
    }

    const sortQueue = () => {
      queue.sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
        if (priorityDiff !== 0) return priorityDiff
        return a.enqueuedAt - b.enqueuedAt
      })
    }

    const processQueue = Effect.fn("RateLimiter.processQueue")(
      function* () {
        sortQueue()

        while (queue.length > 0) {
          const next = queue[0]
          if (!canProceed(next.estimatedTokens)) break

          queue.shift()
          activeCalls++
          tokensUsedThisMinute += next.estimatedTokens
          yield* Deferred.succeed(next.deferred, undefined)
        }
      },
    )

    const acquire = Effect.fn("RateLimiter.acquire")(
      function* (engineerID: EngineerID, priority: Priority, estimatedTokens: number) {
        if (isCircuitBreakerActive()) {
          const remaining = circuitBreakerOpenUntil - Date.now()
          yield* new CircuitBreakerOpenError({ engineerID, remainingMs: remaining })
        }

        if (canProceed(estimatedTokens)) {
          activeCalls++
          tokensUsedThisMinute += estimatedTokens
          return
        }

        const deferred = yield* Deferred.make<void, RateLimitExhaustedError | CircuitBreakerOpenError>()
        const request: PendingRequest = {
          engineerID,
          priority,
          estimatedTokens,
          deferred,
          enqueuedAt: Date.now(),
        }
        queue.push(request)

        yield* processQueue()

        yield* Deferred.await(deferred)
      },
    )

    const release = Effect.fn("RateLimiter.release")(
      function* (_engineerID: EngineerID, _tokensUsed: number) {
        activeCalls = Math.max(0, activeCalls - 1)
        yield* processQueue()
      },
    )

    const report429 = Effect.fn("RateLimiter.report429")(
      function* (engineerID: EngineerID) {
        consecutive429s++

        if (consecutive429s < CIRCUIT_BREAKER_THRESHOLD) return

        circuitBreakerOpen = true
        circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_BLOCK_MS

        const pending = queue.splice(0)
        for (const req of pending) {
          yield* Deferred.fail(req.deferred, new CircuitBreakerOpenError({
            engineerID: req.engineerID,
            remainingMs: CIRCUIT_BREAKER_BLOCK_MS,
          }))
        }
      },
    )

    const resetCircuitBreaker = Effect.fn("RateLimiter.resetCircuitBreaker")(
      function* () {
        circuitBreakerOpen = false
        circuitBreakerOpenUntil = 0
        consecutive429s = 0
      },
    )

    const getStats = (): RateLimiterStats => ({
      activeCalls,
      queuedCalls: queue.length,
      tokensUsedThisMinute,
      tokensBudgetPerMinute: RATE_LIMIT_TOKENS_PER_MIN,
      circuitBreakerOpen: isCircuitBreakerActive(),
      consecutive429s,
    })

    return Service.of({
      acquire,
      release,
      report429,
      resetCircuitBreaker,
      getStats,
    })
  }),
)

export * as RateLimiter from "./rate-limiter"
