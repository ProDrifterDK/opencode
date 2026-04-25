import { Effect, Layer, Context, Schema, Deferred } from "effect"
import {
  RATE_LIMIT_TOKENS_PER_MIN,
  RATE_LIMIT_MAX_CONCURRENT,
  RATE_LIMIT_BASE_BACKOFF_MS,
} from "./constants"
import type { EngineerID, TeamID } from "./types"

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

// Per-team state. All counters, queue, and circuit breaker are isolated per
// TeamID so one team's 429 burst cannot stall another team's engineers.
interface TeamState {
  activeCalls: number
  tokensUsedThisMinute: number
  consecutive429s: number
  circuitBreakerOpen: boolean
  circuitBreakerOpenUntil: number
  minuteWindowStart: number
  queue: PendingRequest[]
}

export interface Interface {
  readonly acquire: (
    teamID: TeamID,
    engineerID: EngineerID,
    priority: Priority,
    estimatedTokens: number,
  ) => Effect.Effect<void, RateLimitExhaustedError | CircuitBreakerOpenError>
  readonly release: (teamID: TeamID, engineerID: EngineerID, tokensUsed: number) => Effect.Effect<void>
  /**
   * Reconcile the token budget after an engineer's loop completes. The
   * acquire step reserved `estimatedTokens` upfront; once the actual usage
   * is known, call this to apply the delta so the minute-window counter
   * reflects reality instead of the estimate.
   *
   * Semantics:
   *   - delta = actualTokens - estimatedTokens
   *   - tokensUsedThisMinute += delta  (clamped to ≥0)
   *
   * Best-effort: if the team state no longer exists (e.g. team dissolved
   * before reconcile ran) the call is a silent no-op.
   */
  readonly reconcile: (
    teamID: TeamID,
    engineerID: EngineerID,
    estimatedTokens: number,
    actualTokens: number,
  ) => Effect.Effect<void>
  readonly report429: (teamID: TeamID, engineerID: EngineerID) => Effect.Effect<void>
  // resetCircuitBreaker is per-team: clears the breaker only for the given team.
  readonly resetCircuitBreaker: (teamID: TeamID) => Effect.Effect<void>
  // getStats(teamID) returns stats for that team, or null if no state exists yet.
  // Returning a single-team result keeps callers simple; they always have a teamID
  // in scope when they need metrics.
  readonly getStats: (teamID: TeamID) => RateLimiterStats | null
  // forgetTeam removes a team's state from the map. Call when a team is dissolved
  // to free the (tiny) memory. Not auto-called — let the caller decide.
  readonly forgetTeam: (teamID: TeamID) => void
}

const PRIORITY_ORDER: Record<Priority, number> = {
  lead: 0,
  engineer: 1,
}

const MAX_BACKOFF_MS = 5 * 60 * 1000
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_BLOCK_MS = 5 * 60 * 1000

export class Service extends Context.Service<Service, Interface>()("@opencode/RateLimiter") {}

const freshTeamState = (): TeamState => ({
  activeCalls: 0,
  tokensUsedThisMinute: 0,
  consecutive429s: 0,
  circuitBreakerOpen: false,
  circuitBreakerOpenUntil: 0,
  minuteWindowStart: Date.now(),
  queue: [],
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Map from TeamID -> per-team mutable state. Lazily populated on first acquire.
    const teamStates = new Map<TeamID, TeamState>()

    const getOrCreateTeamState = (teamID: TeamID): TeamState => {
      let state = teamStates.get(teamID)
      if (!state) {
        state = freshTeamState()
        teamStates.set(teamID, state)
      }
      return state
    }

    // ---- helpers scoped to a single TeamState ----

    const resetMinuteWindow = (s: TeamState) => {
      const now = Date.now()
      if (now - s.minuteWindowStart >= 60_000) {
        s.tokensUsedThisMinute = 0
        s.minuteWindowStart = now
      }
    }

    const hasBudget = (s: TeamState, tokens: number): boolean => {
      resetMinuteWindow(s)
      return s.tokensUsedThisMinute + tokens <= RATE_LIMIT_TOKENS_PER_MIN
    }

    const isCircuitBreakerActive = (s: TeamState): boolean => {
      if (!s.circuitBreakerOpen) return false
      if (Date.now() >= s.circuitBreakerOpenUntil) {
        s.circuitBreakerOpen = false
        s.consecutive429s = 0
        return false
      }
      return true
    }

    const canProceed = (s: TeamState, tokens: number): boolean =>
      s.activeCalls < RATE_LIMIT_MAX_CONCURRENT
      && hasBudget(s, tokens)
      && !isCircuitBreakerActive(s)

    const sortQueue = (s: TeamState) => {
      s.queue.sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
        if (priorityDiff !== 0) return priorityDiff
        return a.enqueuedAt - b.enqueuedAt
      })
    }

    const processQueue = (teamID: TeamID) =>
      Effect.fn("RateLimiter.processQueue")(
        function* () {
          const s = getOrCreateTeamState(teamID)
          sortQueue(s)

          while (s.queue.length > 0) {
            const next = s.queue[0]
            if (!canProceed(s, next.estimatedTokens)) break

            s.queue.shift()
            s.activeCalls++
            s.tokensUsedThisMinute += next.estimatedTokens
            yield* Deferred.succeed(next.deferred, undefined)
          }
        },
      )()

    // ---- public Interface ----

    const acquire = Effect.fn("RateLimiter.acquire")(
      function* (teamID: TeamID, engineerID: EngineerID, priority: Priority, estimatedTokens: number) {
        const s = getOrCreateTeamState(teamID)

        if (isCircuitBreakerActive(s)) {
          const remaining = s.circuitBreakerOpenUntil - Date.now()
          yield* new CircuitBreakerOpenError({ engineerID, remainingMs: remaining })
        }

        if (canProceed(s, estimatedTokens)) {
          s.activeCalls++
          s.tokensUsedThisMinute += estimatedTokens
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
        s.queue.push(request)

        yield* processQueue(teamID)

        yield* Deferred.await(deferred)
      },
    )

    const release = Effect.fn("RateLimiter.release")(
      function* (teamID: TeamID, _engineerID: EngineerID, _tokensUsed: number) {
        const s = getOrCreateTeamState(teamID)
        s.activeCalls = Math.max(0, s.activeCalls - 1)
        yield* processQueue(teamID)
      },
    )

    const reconcile = Effect.fn("RateLimiter.reconcile")(
      function* (teamID: TeamID, _engineerID: EngineerID, estimatedTokens: number, actualTokens: number) {
        const s = teamStates.get(teamID)
        if (!s) return // team already dissolved — silent no-op
        resetMinuteWindow(s)
        const delta = actualTokens - estimatedTokens
        s.tokensUsedThisMinute = Math.max(0, s.tokensUsedThisMinute + delta)
      },
    )

    const report429 = Effect.fn("RateLimiter.report429")(
      function* (teamID: TeamID, engineerID: EngineerID) {
        const s = getOrCreateTeamState(teamID)
        s.consecutive429s++

        if (s.consecutive429s < CIRCUIT_BREAKER_THRESHOLD) return

        s.circuitBreakerOpen = true
        s.circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_BLOCK_MS

        const pending = s.queue.splice(0)
        for (const req of pending) {
          yield* Deferred.fail(req.deferred, new CircuitBreakerOpenError({
            engineerID: req.engineerID,
            remainingMs: CIRCUIT_BREAKER_BLOCK_MS,
          }))
        }
      },
    )

    const resetCircuitBreaker = Effect.fn("RateLimiter.resetCircuitBreaker")(
      function* (teamID: TeamID) {
        const s = getOrCreateTeamState(teamID)
        s.circuitBreakerOpen = false
        s.circuitBreakerOpenUntil = 0
        s.consecutive429s = 0
      },
    )

    const getStats = (teamID: TeamID): RateLimiterStats | null => {
      const s = teamStates.get(teamID)
      if (!s) return null
      return {
        activeCalls: s.activeCalls,
        queuedCalls: s.queue.length,
        tokensUsedThisMinute: s.tokensUsedThisMinute,
        tokensBudgetPerMinute: RATE_LIMIT_TOKENS_PER_MIN,
        circuitBreakerOpen: isCircuitBreakerActive(s),
        consecutive429s: s.consecutive429s,
      }
    }

    const forgetTeam = (teamID: TeamID): void => {
      teamStates.delete(teamID)
    }

    return Service.of({
      acquire,
      release,
      reconcile,
      report429,
      resetCircuitBreaker,
      getStats,
      forgetTeam,
    })
  }),
)

export * as RateLimiter from "./rate-limiter"
