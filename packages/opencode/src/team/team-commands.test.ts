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

    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("$ARGUMENTS")
    expect(parsed.content).toInclude("LeadCoordinator")
    expect(parsed.content).toInclude("SessionCoordinator")
    expect(parsed.content).toInclude("decompose")
    expect(parsed.content).toInclude("spawnEngineer")
    expect(parsed.content).toInclude("assign")
  })

  test("team-status has correct frontmatter and template", () => {
    const content = fs.readFileSync(path.join(COMMAND_DIR, "team-status.md"), "utf8")
    const parsed = matter(content)

    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("monitor")
    expect(parsed.content).toInclude("formatStatus")
    expect(parsed.content).toInclude("listTeamEngineers")
    expect(parsed.content).toInclude("ProgressReport")
  })

  test("team-stop has correct frontmatter and template", () => {
    const content = fs.readFileSync(path.join(COMMAND_DIR, "team-stop.md"), "utf8")
    const parsed = matter(content)

    expect(parsed.data.description).toBeString()
    expect(parsed.data.description.length).toBeGreaterThan(0)
    expect(parsed.data.subtask).toBe(false)
    expect(parsed.content).toInclude("killEngineer")
    expect(parsed.content).toInclude("dissolveTeam")
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
