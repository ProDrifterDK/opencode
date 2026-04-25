/**
 * Unit tests for team_spawn agent name validation (S3).
 *
 * Cannot import from `./team` or `../agent/agent` directly because those
 * modules transitively import `app-runtime.ts`, which has a circular-init
 * ReferenceError at module-evaluation time in the test environment.
 *
 * We test the validation logic inline — mirrors the exact logic in
 * TeamSpawnTool.execute, following the pattern from team-agents-cache.test.ts.
 */
import { describe, test, expect } from "bun:test"
import { TEAM_AGENTS_CACHE_TTL_MS } from "../team/constants"

// ─── Inline agent type (mirrors Agent.Info shape we care about) ──────────────

type AgentItem = { name: string; hidden?: boolean; native?: boolean }

// ─── Inline cache + validation logic (mirrors TeamSpawnTool exactly) ─────────

function makeSpawnValidation() {
  let agentsCache: { value: AgentItem[]; expiresAt: number } | null = null

  /**
   * Resolves the agent by name, using the cache.
   * Returns { agent } on success, { error } on failure.
   */
  const resolve = async (
    agentParam: string | undefined,
    listFn: () => Promise<AgentItem[]>,
    nowMs: number,
  ): Promise<{ agent: AgentItem | null; error: string | null }> => {
    if (!agentParam) {
      return { agent: null, error: null }
    }

    // Cache logic identical to TeamSpawnTool
    const agents =
      agentsCache && agentsCache.expiresAt > nowMs
        ? agentsCache.value
        : await (async () => {
            const fresh = await listFn()
            agentsCache = { value: fresh, expiresAt: nowMs + TEAM_AGENTS_CACHE_TTL_MS }
            return fresh
          })()

    const agent = agents.find(a => a.name.toLowerCase() === agentParam.toLowerCase())
    if (!agent) {
      const available = agents
        .filter(a => !a.hidden && !a.native)
        .map(a => a.name)
      const availableList = available.length > 0 ? available.join(", ") : "(none configured)"
      return { agent: null, error: `Agent '${agentParam}' not found. Available: ${availableList}` }
    }

    return { agent, error: null }
  }

  return { resolve }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("team_spawn agent validation (S3)", () => {
  const agents: AgentItem[] = [
    { name: "engineer-fast", hidden: false, native: false },
    { name: "engineer-deep", hidden: false, native: false },
    { name: "native-internal", hidden: false, native: true },
    { name: "hidden-agent", hidden: true, native: false },
  ]

  test("no agent param → success with null agent (uses session default)", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve(undefined, async () => agents, 1000)

    expect(result.error).toBeNull()
    expect(result.agent).toBeNull()
  })

  test("valid agent name → resolves the agent", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve("engineer-fast", async () => agents, 1000)

    expect(result.error).toBeNull()
    expect(result.agent?.name).toBe("engineer-fast")
  })

  test("valid agent name (case-insensitive) → resolves the agent", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve("ENGINEER-DEEP", async () => agents, 1000)

    expect(result.error).toBeNull()
    expect(result.agent?.name).toBe("engineer-deep")
  })

  test("unknown agent name → error with 'not found' and available list", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve("typo-agent", async () => agents, 1000)

    expect(result.agent).toBeNull()
    expect(result.error).toContain("not found")
    expect(result.error).toContain("typo-agent")
    // Available list excludes native and hidden agents
    expect(result.error).toContain("engineer-fast")
    expect(result.error).toContain("engineer-deep")
    expect(result.error).not.toContain("native-internal")
    expect(result.error).not.toContain("hidden-agent")
  })

  test("error message format: Agent '<name>' not found. Available: <list>", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve("missing-agent", async () => agents, 1000)

    expect(result.error).toBe(
      "Agent 'missing-agent' not found. Available: engineer-fast, engineer-deep"
    )
  })

  test("empty agent name string → treated as no agent (falsy early return)", async () => {
    const { resolve } = makeSpawnValidation()
    const result = await resolve("", async () => agents, 1000)

    // Empty string is falsy in JS, so it follows the same path as undefined
    // (no agent param → use session default, no error)
    expect(result.error).toBeNull()
    expect(result.agent).toBeNull()
  })

  test("no visible agents configured → error says '(none configured)'", async () => {
    const { resolve } = makeSpawnValidation()
    const nativeOnly: AgentItem[] = [
      { name: "native-1", native: true },
      { name: "hidden-1", hidden: true },
    ]
    const result = await resolve("any-agent", async () => nativeOnly, 1000)

    expect(result.error).toContain("not found")
    expect(result.error).toContain("(none configured)")
  })

  test("cache hit: second resolve within TTL does not re-call listFn", async () => {
    let callCount = 0
    const { resolve } = makeSpawnValidation()
    const list = async () => { callCount++; return agents }

    const t0 = 1000
    await resolve("engineer-fast", list, t0)
    await resolve("engineer-deep", list, t0 + 5_000) // still within TTL

    expect(callCount).toBe(1)
  })

  test("cache miss: resolve after TTL re-queries listFn", async () => {
    let callCount = 0
    const { resolve } = makeSpawnValidation()
    const list = async () => { callCount++; return agents }

    const t0 = 1000
    await resolve("engineer-fast", list, t0)
    await resolve("engineer-deep", list, t0 + TEAM_AGENTS_CACHE_TTL_MS + 1)

    expect(callCount).toBe(2)
  })
})

// ─── Fallback agent validation (O1) ───────────────────────────────────────────
//
// `team_spawn` accepts an optional `fallbackAgent` parameter. The validation
// uses the same cache + lookup as the primary `agent` param, but the error
// label is "Fallback agent" instead of "Agent" so the LLM can disambiguate
// which name is wrong when both are provided.

describe("team_spawn fallback agent validation (O1)", () => {
  const agents: AgentItem[] = [
    { name: "engineer-fast", hidden: false, native: false },
    { name: "engineer-deep", hidden: false, native: false },
    { name: "native-internal", hidden: false, native: true },
  ]

  // Mirrors the lookupAgent helper in TeamSpawnTool that takes a label.
  const lookupAgent = (
    rawName: string,
    label: "Agent" | "Fallback agent",
    list: AgentItem[],
  ): { ok: true; agent: AgentItem } | { ok: false; error: string } => {
    const found = list.find(a => a.name.toLowerCase() === rawName.toLowerCase())
    if (!found) {
      const available = list
        .filter(a => !a.hidden && !a.native)
        .map(a => a.name)
      const availableList = available.length > 0 ? available.join(", ") : "(none configured)"
      return { ok: false, error: `${label} '${rawName}' not found. Available: ${availableList}` }
    }
    return { ok: true, agent: found }
  }

  test("valid fallback agent name resolves", () => {
    const r = lookupAgent("engineer-deep", "Fallback agent", agents)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agent.name).toBe("engineer-deep")
  })

  test("unknown fallback agent rejected with 'Fallback agent' label", () => {
    const r = lookupAgent("typo-agent", "Fallback agent", agents)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe(
        "Fallback agent 'typo-agent' not found. Available: engineer-fast, engineer-deep",
      )
    }
  })

  test("primary 'Agent' label and fallback 'Fallback agent' label are distinct", () => {
    const primary = lookupAgent("missing-1", "Agent", agents)
    const fallback = lookupAgent("missing-2", "Fallback agent", agents)
    expect(primary.ok).toBe(false)
    expect(fallback.ok).toBe(false)
    if (!primary.ok) expect(primary.error).toContain("Agent 'missing-1'")
    if (!fallback.ok) expect(fallback.error).toContain("Fallback agent 'missing-2'")
  })

  test("case-insensitive match (parity with primary agent)", () => {
    const r = lookupAgent("ENGINEER-FAST", "Fallback agent", agents)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agent.name).toBe("engineer-fast")
  })
})
