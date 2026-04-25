import { describe, expect, test } from "bun:test"
import matter from "gray-matter"
import fs from "fs"
import path from "path"

const COMMAND_DIR = path.join(__dirname, "../../.opencode/command")

describe("team slash commands", () => {
  const files = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith(".md"))

  test("all three team command files exist", () => {
    const names = files.map((f) => f.replace(/\.md$/, ""))
    expect(names).toContain("team-start")
    expect(names).toContain("team-status")
    expect(names).toContain("team-stop")
  })

  test("team-start has correct frontmatter and template", () => {
    const content = fs.readFileSync(path.join(COMMAND_DIR, "team-start.md"), "utf8")
    const parsed = matter(content)

    // The prompt MUST talk in terms of LLM-callable tools (team_*), not
    // Effect service names (SessionCoordinator / LeadCoordinator /
    // spawnEngineer) — the original prompt instructed the LLM to call
    // Effect methods directly, which LLMs can't do (see
    // docs/superpowers/specs/2026-04-22-team-tools-design.md, Problem
    // Statement).
    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("$ARGUMENTS")
    expect(parsed.content).toInclude("team_create")
    expect(parsed.content).toInclude("team_decompose")
    expect(parsed.content).toInclude("team_spawn")
    expect(parsed.content).toInclude("team_monitor")
    expect(parsed.content).toInclude("team_dissolve")
  })

  test("team-status has correct frontmatter and template", () => {
    const content = fs.readFileSync(path.join(COMMAND_DIR, "team-status.md"), "utf8")
    const parsed = matter(content)

    // Like team-start, the prompt must reference LLM-callable tool
    // names (team_*), not Effect service methods. `monitor` and
    // `ProgressReport` remain as natural-language concepts in the
    // prompt body, but the actionable API is `team_monitor` /
    // `team_roster`.
    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("team_monitor")
    expect(parsed.content).toInclude("team_roster")
    expect(parsed.content).toInclude("$ARGUMENTS")
    expect(parsed.content).toInclude("ProgressReport")
  })

  test("team-stop has correct frontmatter and template", () => {
    const content = fs.readFileSync(path.join(COMMAND_DIR, "team-stop.md"), "utf8")
    const parsed = matter(content)

    // The prompt must talk in LLM-callable tool names. The actual
    // tools are `team_kill` (single engineer) and `team_dissolve`
    // (whole team), not the old Effect-service pseudo-API
    // (`killEngineer` / `dissolveTeam`).
    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("team_kill")
    expect(parsed.content).toInclude("team_dissolve")
    expect(parsed.content).toInclude("$ARGUMENTS")
  })

  test("all commands have non-empty templates", () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(COMMAND_DIR, file), "utf8")
      const parsed = matter(content)
      expect(parsed.content.trim().length).toBeGreaterThan(0)
    }
  })

  test("frontmatter only contains valid fields", () => {
    const validKeys = new Set(["description", "agent", "model", "subtask"])
    for (const file of files) {
      const content = fs.readFileSync(path.join(COMMAND_DIR, file), "utf8")
      const parsed = matter(content)
      for (const key of Object.keys(parsed.data)) {
        expect(validKeys.has(key)).toBe(true)
      }
    }
  })
})
