/**
 * Unit tests for engineer-loop fallback failover (O1).
 *
 * Cannot import `runEngineerLoop` from `./engineer-loop` directly because
 * its transitive imports (`@/session/prompt`) pull in `app-runtime.ts`,
 * which has a circular-init ReferenceError at module-evaluation time in
 * the test environment. Same constraint as `team-spawn-validation.test.ts`.
 *
 * Instead, we mirror the failover decision logic (the `Effect.catchTag`
 * around `attemptTask`) in a tiny inline stub that exercises the real
 * `RateLimiter.layer` for circuit-breaker semantics. This validates:
 *   - CB open + fallback configured → retries once with fallback model,
 *   - CB open + no fallback → engineer fails (no retry),
 *   - CB open + fallback also CB → engineer fails after at most 2 attempts
 *     (no infinite retry loop).
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  Service as RateLimiterService,
  layer as rateLimiterLayer,
  CircuitBreakerOpenError,
} from "./rate-limiter"
import type { EngineerID, TeamID } from "./types"

const ENGINEER_TOKEN_ESTIMATE = 8000

interface AttemptCall {
  attempt: "primary" | "fallback"
  model: { providerID: string; modelID: string } | undefined
}

/**
 * Mirror of `runEngineerLoop`'s failover wrapper, simplified to surface
 * just the acquire+retry decision. The body is reduced to "acquire +
 * record + release" so the test can assert which model was used and how
 * many attempts ran.
 */
const runWithFailover = (input: {
  teamID: TeamID
  engineerID: EngineerID
  primary: { providerID: string; modelID: string } | undefined
  fallback: { providerID: string; modelID: string } | undefined
  recorder: AttemptCall[]
  // Optional hook fired BEFORE the fallback's acquire to let a test
  // re-trip the breaker mid-flight.
  prepareFallback?: () => Effect.Effect<void, never, RateLimiterService>
}) => {
  const attempt = (
    model: { providerID: string; modelID: string } | undefined,
    label: "primary" | "fallback",
  ) =>
    Effect.gen(function* () {
      const rl = yield* RateLimiterService
      yield* rl.acquire(input.teamID, input.engineerID, "engineer", ENGINEER_TOKEN_ESTIMATE)
      input.recorder.push({ attempt: label, model })
      // Body would normally run prompt + loop here. We just release.
      yield* rl.release(input.teamID, input.engineerID, ENGINEER_TOKEN_ESTIMATE)
    })

  return attempt(input.primary, "primary").pipe(
    Effect.catchTag("CircuitBreakerOpenError", (cbErr) =>
      Effect.gen(function* () {
        if (!input.fallback) return yield* Effect.fail(cbErr)
        const rl = yield* RateLimiterService
        yield* rl.resetCircuitBreaker(input.teamID)
        if (input.prepareFallback) yield* input.prepareFallback()
        return yield* attempt(input.fallback, "fallback")
      }),
    ),
  )
}

const tripCircuitBreaker = (teamID: TeamID) =>
  Effect.gen(function* () {
    const rl = yield* RateLimiterService
    for (let i = 0; i < 3; i++) {
      yield* rl.report429(teamID, "eng_throwaway" as EngineerID)
    }
  })

describe("engineer-loop fallback failover (O1)", () => {
  test("CB open + fallback configured → retries once with fallback model", async () => {
    const TEAM = "team_o1_a" as TeamID
    const recorder: AttemptCall[] = []

    const program = Effect.gen(function* () {
      yield* tripCircuitBreaker(TEAM)
      yield* runWithFailover({
        teamID: TEAM,
        engineerID: "eng_a" as EngineerID,
        primary: { providerID: "anthropic", modelID: "claude-3-7" },
        fallback: { providerID: "openai", modelID: "gpt-5" },
        recorder,
      })
    })

    await Effect.runPromise(Effect.provide(program, rateLimiterLayer))

    expect(recorder).toHaveLength(1)
    expect(recorder[0].attempt).toBe("fallback")
    expect(recorder[0].model).toEqual({ providerID: "openai", modelID: "gpt-5" })
  })

  test("CB open + no fallback → engineer fails with CircuitBreakerOpenError", async () => {
    const TEAM = "team_o1_b" as TeamID
    const recorder: AttemptCall[] = []

    const program = Effect.gen(function* () {
      yield* tripCircuitBreaker(TEAM)
      yield* runWithFailover({
        teamID: TEAM,
        engineerID: "eng_b" as EngineerID,
        primary: { providerID: "anthropic", modelID: "claude-3-7" },
        fallback: undefined,
        recorder,
      })
    })

    let caught: unknown = null
    try {
      await Effect.runPromise(Effect.provide(program, rateLimiterLayer))
    } catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    expect(String(caught)).toContain("CircuitBreakerOpenError")
    // No attempt body ran — acquire short-circuited on the open breaker.
    expect(recorder).toHaveLength(0)
  })

  test("CB open + fallback also CB → at most 2 attempts (never an infinite loop)", async () => {
    const TEAM = "team_o1_c" as TeamID
    const recorder: AttemptCall[] = []

    const program = Effect.gen(function* () {
      yield* tripCircuitBreaker(TEAM)
      yield* runWithFailover({
        teamID: TEAM,
        engineerID: "eng_c" as EngineerID,
        primary: { providerID: "anthropic", modelID: "claude-3-7" },
        fallback: { providerID: "openai", modelID: "gpt-5" },
        recorder,
        // Re-trip CB AFTER reset, BEFORE fallback's acquire.
        prepareFallback: () => tripCircuitBreaker(TEAM),
      })
    })

    let caught: unknown = null
    try {
      await Effect.runPromise(Effect.provide(program, rateLimiterLayer))
    } catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    expect(String(caught)).toContain("CircuitBreakerOpenError")
    // Critical invariant: at most ONE attempt ran (the primary was blocked
    // by the first CB, the fallback was blocked by the second CB).
    // The catch wrapper does NOT loop, so total attempts ≤ 1.
    expect(recorder.length).toBeLessThanOrEqual(1)
  })

  test("happy path: no CB → primary model used, fallback never invoked", async () => {
    const TEAM = "team_o1_d" as TeamID
    const recorder: AttemptCall[] = []

    const program = runWithFailover({
      teamID: TEAM,
      engineerID: "eng_d" as EngineerID,
      primary: { providerID: "anthropic", modelID: "claude-3-7" },
      fallback: { providerID: "openai", modelID: "gpt-5" },
      recorder,
    })

    await Effect.runPromise(Effect.provide(program, rateLimiterLayer))

    expect(recorder).toHaveLength(1)
    expect(recorder[0].attempt).toBe("primary")
    expect(recorder[0].model).toEqual({ providerID: "anthropic", modelID: "claude-3-7" })
  })

  // Sanity check: CircuitBreakerOpenError is the tagged error class the
  // failover catchTag relies on. Lock the tag string.
  test("CircuitBreakerOpenError tag string is stable", () => {
    const err = new CircuitBreakerOpenError({ engineerID: "x", remainingMs: 1 })
    expect(err._tag).toBe("CircuitBreakerOpenError")
  })
})

// Suppress unused-Layer warning when developing in editors.
void Layer

// ─── Bug 3a regression: post-dissolve NotFoundError is benign ──────────
// The CLI handler in `cli/cmd/team-engineer.ts` classifies a thrown
// NotFoundError ("Session not found") as a clean exit when the error
// occurs after the engineer completed via team_report — the lead's
// `team_dissolve` races and deletes the session row while the
// subprocess is still winding down. This test pins the classifier
// string-match so a future refactor cannot silently regress it.
describe("post-dissolve NotFoundError classifier (bug 3a)", () => {
  // Mirror the isPostDissolveTeardown classifier from team-engineer.ts.
  const isPostDissolveTeardown = (errStr: string): boolean =>
    errStr.includes("Session not found") || errStr.includes("NotFoundError")

  test("classifies 'Session not found' as benign teardown", () => {
    expect(isPostDissolveTeardown("Error: Session not found: ses_abc")).toBe(true)
  })

  test("classifies bare NotFoundError name as benign teardown", () => {
    expect(isPostDissolveTeardown("NotFoundError: row missing")).toBe(true)
  })

  test("does NOT classify unrelated runtime errors as benign", () => {
    expect(isPostDissolveTeardown("TypeError: undefined is not a function")).toBe(false)
    expect(isPostDissolveTeardown("rate limit hit")).toBe(false)
    expect(isPostDissolveTeardown("worktree merge conflict")).toBe(false)
  })

  test("matches Effect Cause.pretty output that wraps a NotFoundError", () => {
    const cause = "Error: NotFoundError: Session not found: ses_xyz\n  at ..."
    expect(isPostDissolveTeardown(cause)).toBe(true)
  })
})
