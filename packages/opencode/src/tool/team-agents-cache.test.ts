/**
 * Unit tests for the team_agents caching layer (E4).
 *
 * We cannot import from `./team` or `../agent/agent` because those modules
 * transitively import `app-runtime.ts`, which has a circular-init
 * `ReferenceError` at module-evaluation time in the test environment.
 *
 * Instead we test the cache logic inline with plain functions — the cache
 * itself is pure TS (module-level mutable object + Date.now() comparison).
 * This matches the pattern used in team-commit-tool.test.ts.
 */
import { describe, test, expect } from "bun:test"
import { TEAM_AGENTS_CACHE_TTL_MS } from "../team/constants"

// ─── Inline cache logic (mirrors TeamAgentsTool exactly) ────────────────────

type AgentItem = { name: string }

/**
 * Creates an isolated instance of the cache + execute function so each test
 * suite gets fresh state (no module-level pollution between tests).
 */
function makeAgentsCache() {
  let agentsCache: { value: AgentItem[]; expiresAt: number } | null = null

  /**
   * Executes the cached agents query.
   * `listFn` is the inner provider call (spy-able).
   * `nowMs` replaces `Date.now()` for deterministic time control.
   */
  const execute = async (listFn: () => Promise<AgentItem[]>, nowMs: number): Promise<AgentItem[]> => {
    if (agentsCache && agentsCache.expiresAt > nowMs) {
      return agentsCache.value
    }
    const fresh = await listFn()
    agentsCache = { value: fresh, expiresAt: nowMs + TEAM_AGENTS_CACHE_TTL_MS }
    return fresh
  }

  return { execute }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("team_agents cache (E4)", () => {
  test("TTL constant is 30 000 ms", () => {
    expect(TEAM_AGENTS_CACHE_TTL_MS).toBe(30_000)
  })

  test("first call queries the provider list", async () => {
    let callCount = 0
    const { execute } = makeAgentsCache()
    const list = async () => { callCount++; return [{ name: "a" }] }

    const result = await execute(list, 1000)

    expect(callCount).toBe(1)
    expect(result).toEqual([{ name: "a" }])
  })

  test("second call within TTL returns cached value without re-querying", async () => {
    let callCount = 0
    const { execute } = makeAgentsCache()
    const list = async () => { callCount++; return [{ name: "b" }] }

    const t0 = 1000
    await execute(list, t0)
    // 5 s later — still within 30 s TTL
    const result2 = await execute(list, t0 + 5_000)

    expect(callCount).toBe(1)
    expect(result2).toEqual([{ name: "b" }])
  })

  test("call after TTL expiry re-queries the provider list", async () => {
    let callCount = 0
    const { execute } = makeAgentsCache()
    const list = async () => { callCount++; return [{ name: "c" }] }

    const t0 = 1000
    await execute(list, t0)
    // 31 s later — past the 30 s TTL
    await execute(list, t0 + TEAM_AGENTS_CACHE_TTL_MS + 1)

    expect(callCount).toBe(2)
  })

  test("cache expires exactly at TTL boundary (strict greater-than)", async () => {
    let callCount = 0
    const { execute } = makeAgentsCache()
    const list = async () => { callCount++; return [{ name: "d" }] }

    const t0 = 0
    // First call: expiresAt = t0 + 30_000
    await execute(list, t0)
    // Call exactly at expiresAt — expiresAt > nowMs is false (equal), so re-queries
    await execute(list, t0 + TEAM_AGENTS_CACHE_TTL_MS)

    expect(callCount).toBe(2)
  })

  test("each makeAgentsCache instance has independent state", async () => {
    let callsA = 0
    let callsB = 0
    const instanceA = makeAgentsCache()
    const instanceB = makeAgentsCache()
    const listA = async () => { callsA++; return [{ name: "a" }] }
    const listB = async () => { callsB++; return [{ name: "b" }] }

    const t0 = 1000
    await instanceA.execute(listA, t0)
    // Second call on A — hits cache
    await instanceA.execute(listA, t0 + 1_000)
    // First call on B — fresh
    await instanceB.execute(listB, t0)

    expect(callsA).toBe(1)
    expect(callsB).toBe(1)
  })
})
