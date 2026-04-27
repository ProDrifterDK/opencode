import { describe, expect, test } from "bun:test"
import { isOpenCodeAgentSource, isTeamVisibleAgent } from "./agent-source"

describe("team agent source filtering", () => {
  const globalConfig = "/home/dev/.config/opencode"

  test("accepts global and project OpenCode config sources", () => {
    expect(isOpenCodeAgentSource("/home/dev/.config/opencode", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("/home/dev/.config/opencode/agents/reviewer.md", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("/repo/.opencode/agents/reviewer.md", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("/repo/opencode.json", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("/repo/opencode.jsonc", globalConfig)).toBe(true)
  })

  test("accepts OpenCode-managed non-file config sources", () => {
    expect(isOpenCodeAgentSource("https://opencode.example/.well-known/opencode", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("https://opencode.example/api/config", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("OPENCODE_CONFIG_CONTENT", globalConfig)).toBe(true)
    expect(isOpenCodeAgentSource("mobileconfig:/Library/Managed Preferences/ai.opencode.managed.plist", globalConfig)).toBe(true)
  })

  test("rejects Claude-compatible external agent sources", () => {
    expect(isOpenCodeAgentSource("/home/dev/.claude/agents/reviewer.md", globalConfig)).toBe(false)
    expect(isOpenCodeAgentSource("/home/dev/.agents/reviewer.md", globalConfig)).toBe(false)
    expect(isOpenCodeAgentSource("", globalConfig)).toBe(false)
  })

  test("hides external agents without config provenance", () => {
    expect(isTeamVisibleAgent({ name: "oh-my-claudecode:oracle" }, undefined, { globalConfig })).toBe(false)
  })

  test("shows non-native agents from OpenCode-managed provenance", () => {
    expect(
      isTeamVisibleAgent(
        { name: "remote-reviewer" },
        { "remote-reviewer": { source: "https://opencode.example/api/config" } },
        { globalConfig },
      ),
    ).toBe(true)
    expect(
      isTeamVisibleAgent(
        { name: "env-reviewer" },
        { "env-reviewer": { source: "OPENCODE_CONFIG_CONTENT" } },
        { globalConfig },
      ),
    ).toBe(true)
  })

  test("applies hidden and native visibility rules before provenance", () => {
    expect(
      isTeamVisibleAgent(
        { name: "hidden-reviewer", hidden: true },
        { "hidden-reviewer": { source: "/repo/.opencode/agents/reviewer.md" } },
        { globalConfig },
      ),
    ).toBe(false)
    expect(isTeamVisibleAgent({ name: "build", native: true }, undefined, { globalConfig })).toBe(false)
    expect(isTeamVisibleAgent({ name: "build", native: true }, undefined, { includeNative: true, globalConfig })).toBe(true)
  })
})
