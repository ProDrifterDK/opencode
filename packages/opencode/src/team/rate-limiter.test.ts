import { describe, test, expect } from "bun:test"
import { Effect, Scope, Fiber } from "effect"
import {
  Service as RateLimiterService,
  CircuitBreakerOpenError,
} from "./rate-limiter"
import type { EngineerID, TeamID } from "./types"

const TEAM_A = "team_a" as TeamID
const TEAM_B = "team_b" as TeamID

const ENG_LEAD = "eng_lead" as EngineerID
const ENG_A = "eng_a" as EngineerID
const ENG_B = "eng_b" as EngineerID
const ENG_C = "eng_c" as EngineerID

import { layer } from "./rate-limiter"

const resolvedLayer = layer

const runWith = <A>(
  effect: Effect.Effect<A, any, RateLimiterService>,
) =>
  Effect.provide(effect, resolvedLayer).pipe(Effect.runPromise)

const runWithScope = <A>(
  effect: Effect.Effect<A, any, RateLimiterService | Scope.Scope>,
) =>
  Effect.provide(effect, resolvedLayer).pipe(
    Effect.scoped,
    Effect.runPromise,
  )

describe("RateLimiter", () => {
  test("acquire proceeds immediately when under budget", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.acquire(TEAM_A, ENG_A, "engineer", 1000)
      return service.getStats(TEAM_A)
    }))

    expect(result?.activeCalls).toBe(1)
    expect(result?.tokensUsedThisMinute).toBe(1000)
  })

  test("5 concurrent requests — 4 proceed, 1 queued", async () => {
    const result = await runWithScope(Effect.gen(function* () {
      const service = yield* RateLimiterService

      for (let i = 0; i < 4; i++) {
        yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
          Effect.forkScoped,
        )
      }

      yield* Effect.sleep(5)
      expect(service.getStats(TEAM_A)?.activeCalls).toBe(4)

      yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(Effect.forkScoped)
      yield* Effect.sleep(5)

      return service.getStats(TEAM_A)
    }))

    expect(result?.queuedCalls).toBe(1)
    expect(result?.activeCalls).toBe(4)
  })

  test("priority ordering — lead goes before engineer", async () => {
    const result = await runWithScope(Effect.gen(function* () {
      const service = yield* RateLimiterService

      for (let i = 0; i < 4; i++) {
        yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
          Effect.forkScoped,
        )
      }

      yield* Effect.sleep(5)

      const order: string[] = []

      yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(
        Effect.tap(() => Effect.sync(() => order.push("engineer"))),
        Effect.forkScoped,
      )
      yield* service.acquire(TEAM_A, ENG_LEAD, "lead", 100).pipe(
        Effect.tap(() => Effect.sync(() => order.push("lead"))),
        Effect.forkScoped,
      )

      yield* Effect.sleep(5)
      yield* service.release(TEAM_A, `eng_fill_0` as EngineerID, 100)
      yield* Effect.sleep(10)

      return order
    }))

    expect(result[0]).toBe("lead")
  })

  test("circuit breaker triggers after 3 consecutive 429s", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      return service.getStats(TEAM_A)
    }))

    expect(result?.circuitBreakerOpen).toBe(true)
    expect(result?.consecutive429s).toBe(3)
  })

  test("acquire fails with CircuitBreakerOpenError when breaker is open", async () => {
    const error = await runWith(
      Effect.gen(function* () {
        const service = yield* RateLimiterService
        yield* service.report429(TEAM_A, ENG_A)
        yield* service.report429(TEAM_A, ENG_A)
        yield* service.report429(TEAM_A, ENG_A)
        yield* service.acquire(TEAM_A, ENG_B, "engineer", 100)
      }).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(CircuitBreakerOpenError)
    expect((error as CircuitBreakerOpenError).remainingMs).toBeGreaterThan(0)
  })

  test("resetCircuitBreaker clears breaker state", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      expect(service.getStats(TEAM_A)?.circuitBreakerOpen).toBe(true)

      yield* service.resetCircuitBreaker(TEAM_A)
      return service.getStats(TEAM_A)
    }))

    expect(result?.circuitBreakerOpen).toBe(false)
    expect(result?.consecutive429s).toBe(0)
  })

  test("release processes queued requests", async () => {
    const result = await runWithScope(Effect.gen(function* () {
      const service = yield* RateLimiterService

      for (let i = 0; i < 4; i++) {
        yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
          Effect.forkScoped,
        )
      }

      yield* Effect.sleep(5)

      yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(Effect.forkScoped)
      yield* Effect.sleep(5)
      expect(service.getStats(TEAM_A)?.queuedCalls).toBe(1)

      yield* service.release(TEAM_A, `eng_fill_0` as EngineerID, 100)
      yield* Effect.sleep(10)

      return service.getStats(TEAM_A)
    }))

    expect(result?.activeCalls).toBe(4)
    expect(result?.queuedCalls).toBe(0)
  })

  test("report429 with <3 failures does not disrupt queued requests", async () => {
    const result = await runWithScope(
      Effect.gen(function* () {
        const service = yield* RateLimiterService

        for (let i = 0; i < 4; i++) {
          yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
            Effect.forkScoped,
          )
        }

        yield* Effect.sleep(5)

        yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(Effect.forkScoped)
        yield* Effect.sleep(5)
        expect(service.getStats(TEAM_A)?.queuedCalls).toBe(1)

        yield* service.report429(TEAM_A, ENG_C)
        expect(service.getStats(TEAM_A)?.consecutive429s).toBe(1)
        expect(service.getStats(TEAM_A)?.queuedCalls).toBe(1)
        expect(service.getStats(TEAM_A)?.circuitBreakerOpen).toBe(false)

        yield* service.release(TEAM_A, `eng_fill_0` as EngineerID, 100)
        yield* Effect.sleep(10)

        return service.getStats(TEAM_A)
      }),
    )

    expect(result?.activeCalls).toBe(4)
    expect(result?.queuedCalls).toBe(0)
  })

  test("getStats returns correct snapshot", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.acquire(TEAM_A, ENG_A, "engineer", 5000)
      yield* service.acquire(TEAM_A, ENG_B, "lead", 3000)
      return service.getStats(TEAM_A)
    }))

    expect(result?.activeCalls).toBe(2)
    expect(result?.tokensUsedThisMinute).toBe(8000)
    expect(result?.tokensBudgetPerMinute).toBe(100_000)
    expect(result?.circuitBreakerOpen).toBe(false)
    expect(result?.consecutive429s).toBe(0)
  })

  test("getStats returns null for unknown team", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      return service.getStats("team_never_used" as TeamID)
    }))

    expect(result).toBeNull()
  })

  test("fair scheduling within same priority — FIFO order", async () => {
    const result = await runWithScope(Effect.gen(function* () {
      const service = yield* RateLimiterService

      for (let i = 0; i < 4; i++) {
        yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
          Effect.forkScoped,
        )
      }

      yield* Effect.sleep(5)

      const order: string[] = []

      yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(
        Effect.tap(() => Effect.sync(() => order.push("A"))),
        Effect.forkScoped,
      )
      yield* service.acquire(TEAM_A, ENG_B, "engineer", 100).pipe(
        Effect.tap(() => Effect.sync(() => order.push("B"))),
        Effect.forkScoped,
      )

      yield* Effect.sleep(5)

      yield* service.release(TEAM_A, `eng_fill_0` as EngineerID, 100)
      yield* Effect.sleep(10)
      yield* service.release(TEAM_A, `eng_fill_1` as EngineerID, 100)
      yield* Effect.sleep(10)

      return order
    }))

    expect(result).toEqual(["A", "B"])
  })

  test("exponential backoff — consecutive 429 tracking", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      return service.getStats(TEAM_A)
    }))

    expect(result?.consecutive429s).toBe(2)
  })

  test("circuit breaker fails all queued requests", async () => {
    const result = await runWithScope(
      Effect.gen(function* () {
        const service = yield* RateLimiterService

        for (let i = 0; i < 4; i++) {
          yield* service.acquire(TEAM_A, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
            Effect.forkScoped,
          )
        }

        yield* Effect.sleep(5)

        const fiberA = yield* service.acquire(TEAM_A, ENG_A, "engineer", 100).pipe(
          Effect.flip,
          Effect.forkScoped,
        )
        const fiberB = yield* service.acquire(TEAM_A, ENG_B, "lead", 100).pipe(
          Effect.flip,
          Effect.forkScoped,
        )

        yield* Effect.sleep(5)

        yield* service.report429(TEAM_A, ENG_C)
        yield* service.report429(TEAM_A, ENG_C)
        yield* service.report429(TEAM_A, ENG_C)

        const errorA = yield* Fiber.join(fiberA)
        const errorB = yield* Fiber.join(fiberB)

        return { errorA, errorB }
      }),
    )

    expect(result.errorA).toBeInstanceOf(CircuitBreakerOpenError)
    expect(result.errorB).toBeInstanceOf(CircuitBreakerOpenError)
  })

  // --- isolation tests ---

  test("two teams have independent token budgets", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService

      // Consume half the budget on Team A
      yield* service.acquire(TEAM_A, ENG_A, "engineer", 50_000)

      // Team B should still have its full budget untouched
      yield* service.acquire(TEAM_B, ENG_B, "engineer", 50_000)

      const statsA = service.getStats(TEAM_A)
      const statsB = service.getStats(TEAM_B)

      return { tokensA: statsA?.tokensUsedThisMinute, tokensB: statsB?.tokensUsedThisMinute }
    }))

    // Each team tracks its own usage independently
    expect(result.tokensA).toBe(50_000)
    expect(result.tokensB).toBe(50_000)
  })

  test("Team A circuit breaker does NOT block Team B", async () => {
    const result = await runWith(Effect.gen(function* () {
      const service = yield* RateLimiterService

      // Trip Team A's circuit breaker
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)
      yield* service.report429(TEAM_A, ENG_A)

      expect(service.getStats(TEAM_A)?.circuitBreakerOpen).toBe(true)

      // Team B should acquire successfully
      yield* service.acquire(TEAM_B, ENG_B, "engineer", 1000)

      return service.getStats(TEAM_B)
    }))

    // Team B acquired successfully — breaker on A did not bleed over
    expect(result?.activeCalls).toBe(1)
    expect(result?.circuitBreakerOpen).toBe(false)
  })
})
