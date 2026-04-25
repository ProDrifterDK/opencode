import { describe, test, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildDissolveSummary } from "./dissolve-summary"
import type { Task, TaskBoardID, TeamID, EngineerID } from "./task-board.sql"
import type { EngineerSlot } from "./session-coordinator"
import type { SessionID } from "../session/schema"

// ── Fixture helpers ───────────────────────────────────────────────────────
const TEAM = "team_test" as TeamID

const makeTask = (overrides: { id: string; title: string; status: Task["status"] } & Partial<Omit<Task, "id" | "title" | "status">>): Task => ({
  id: overrides.id as unknown as TaskBoardID,
  team_id: TEAM,
  title: overrides.title,
  description: overrides.description ?? null,
  status: overrides.status,
  assigned_engineer_id: (overrides.assigned_engineer_id ?? null) as EngineerID | null,
  file_scope: overrides.file_scope ?? null,
  blocked_by: (overrides.blocked_by ?? null) as TaskBoardID | null,
  parent_task_id: (overrides.parent_task_id ?? null) as TaskBoardID | null,
  dependencies: overrides.dependencies ?? [],
  time_created: overrides.time_created ?? 1_700_000_000_000,
  time_updated: overrides.time_updated ?? 1_700_000_000_000,
  completed_at: overrides.completed_at ?? null,
  archived_at: overrides.archived_at ?? null,
})

const makeEngineer = (overrides: { engineerID: string; name: string } & Partial<Omit<EngineerSlot, "engineerID" | "name">>): EngineerSlot => ({
  engineerID: overrides.engineerID as unknown as EngineerID,
  teamID: TEAM,
  sessionID: ("sess_" + overrides.engineerID) as SessionID,
  name: overrides.name,
  state: overrides.state ?? "idle",
  currentTask: overrides.currentTask ?? null,
  agentName: overrides.agentName ?? "build-agent",
  agentColor: overrides.agentColor ?? "blue",
  fallbackAgent: overrides.fallbackAgent ?? null,
  startedAt: overrides.startedAt ?? 1_700_000_000_000,
  lastHeartbeat: overrides.lastHeartbeat ?? 1_700_000_000_000,
})

const FIXED_DISSOLVED_AT = "2026-04-25T12:34:56.000Z"

describe("buildDissolveSummary", () => {
  test("renders full fixture: 3 tasks (1 completed, 1 failed, 1 pending), 2 engineers", () => {
    const tasks: Task[] = [
      makeTask({
        id: "t1",
        title: "Implement feature X",
        status: "completed",
        assigned_engineer_id: "eng_a" as EngineerID,
        completed_at: 1_700_000_300_000,
      }),
      makeTask({
        id: "t2",
        title: "Write tests for X",
        status: "failed",
        assigned_engineer_id: "eng_b" as EngineerID,
        description: "Test runner crashed",
      }),
      makeTask({ id: "t3", title: "Document X", status: "pending" }),
    ]
    const engineers: EngineerSlot[] = [
      makeEngineer({
        engineerID: "eng_a",
        name: "engineer-feature",
        state: "idle",
        currentTask: "Wrapped up feature X",
        agentName: "build",
        agentColor: "green",
      }),
      makeEngineer({
        engineerID: "eng_b",
        name: "engineer-test",
        state: "failed",
        currentTask: "Crashed during test setup",
      }),
    ]

    const md = buildDissolveSummary({
      teamID: TEAM,
      tasks,
      engineers,
      durationMs: 60 * 60 * 1000 + 30 * 60 * 1000, // 1h 30m
      dissolvedAt: FIXED_DISSOLVED_AT,
    })

    expect(md).toInclude(`# Team Dissolve Summary — ${TEAM}`)
    expect(md).toInclude(`**Dissolved**: ${FIXED_DISSOLVED_AT}`)
    expect(md).toInclude(`**Duration**: 1h 30m from team_create`)
    expect(md).toInclude("**Engineers**: 2")
    expect(md).toInclude("**Tasks total**: 3")

    expect(md).toInclude("### Completed (1)")
    expect(md).toInclude(`"Implement feature X" — engineer-feature — completed at ${new Date(1_700_000_300_000).toISOString()}`)

    expect(md).toInclude("### Failed (1)")
    expect(md).toInclude(`"Write tests for X" — engineer-test — error: Test runner crashed`)

    expect(md).toInclude("### Pending/blocked at dissolve (1)")
    expect(md).toInclude(`"Document X" — status: pending`)

    expect(md).toInclude("### engineer-feature (build, green)")
    expect(md).toInclude("- State at dissolve: idle")
    expect(md).toInclude("- Tasks worked: 1")
    expect(md).toInclude("- Last report: Wrapped up feature X")

    expect(md).toInclude("### engineer-test (build-agent, blue)")
    expect(md).toInclude("- State at dissolve: failed")
  })

  test("empty tasks renders zero counts and 'none' bullets", () => {
    const md = buildDissolveSummary({
      teamID: TEAM,
      tasks: [],
      engineers: [makeEngineer({ engineerID: "eng_a", name: "engineer-solo" })],
      durationMs: 5_000,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    expect(md).toInclude("**Tasks total**: 0")
    expect(md).toInclude("### Completed (0)\n- _none_")
    expect(md).toInclude("### Failed (0)\n- _none_")
    expect(md).toInclude("### Pending/blocked at dissolve (0)\n- _none_")
  })

  test("empty engineers renders dedicated note", () => {
    const md = buildDissolveSummary({
      teamID: TEAM,
      tasks: [],
      engineers: [],
      durationMs: 0,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    expect(md).toInclude("**Engineers**: 0")
    expect(md).toInclude("_No engineers were spawned for this team._")
  })

  test("long currentTask report is truncated to 200 chars + ellipsis", () => {
    const longText = "x".repeat(500)
    const md = buildDissolveSummary({
      teamID: TEAM,
      tasks: [],
      engineers: [
        makeEngineer({
          engineerID: "eng_a",
          name: "engineer-long",
          currentTask: longText,
        }),
      ],
      durationMs: 1_000,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    // Match the truncated payload directly.
    const truncated = "x".repeat(200) + "…"
    expect(md).toInclude(`- Last report: ${truncated}`)
    // Sanity: full untruncated string must NOT appear.
    expect(md).not.toInclude(longText)
  })

  test("special chars in titles are escaped/handled (newlines stripped, pipes escaped)", () => {
    const tasks: Task[] = [
      makeTask({
        id: "t1",
        title: "title with\nnewline and | pipe",
        status: "completed",
        assigned_engineer_id: "eng_a" as EngineerID,
        completed_at: 1_700_000_000_000,
      }),
    ]
    const engineers: EngineerSlot[] = [
      makeEngineer({ engineerID: "eng_a", name: "engineer-x" }),
    ]
    const md = buildDissolveSummary({
      teamID: TEAM,
      tasks,
      engineers,
      durationMs: 1_000,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    // Newline should be replaced with a space; pipe should be escaped.
    expect(md).toInclude(`"title with newline and \\| pipe"`)
    // No raw newline mid-title.
    expect(md).not.toInclude("title with\nnewline")
  })

  test("dissolve summary file write contract: .tmp/team-<id>-summary.md", () => {
    // Mirrors the filesystem contract used by TeamDissolveTool: the tool
    // writes the rendered markdown to `<repoRoot>/.tmp/team-<teamID>-summary.md`.
    // Here we substitute a fresh temp directory for the repo root so the
    // assertion doesn't pollute the working tree.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "team-dissolve-"))
    const teamID = "team_integration_test"
    const md = buildDissolveSummary({
      teamID,
      tasks: [],
      engineers: [],
      durationMs: 1_000,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    const relPath = path.join(".tmp", `team-${teamID}-summary.md`)
    const absPath = path.join(tmpRoot, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, md, "utf8")

    expect(fs.existsSync(absPath)).toBe(true)
    const written = fs.readFileSync(absPath, "utf8")
    expect(written).toInclude(`# Team Dissolve Summary — ${teamID}`)
    expect(written).toInclude(`**Dissolved**: ${FIXED_DISSOLVED_AT}`)

    // Cleanup
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  test("duration formatting handles seconds-only and negative inputs", () => {
    const mdSeconds = buildDissolveSummary({
      teamID: TEAM,
      tasks: [],
      engineers: [],
      durationMs: 12_500, // 12s
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    expect(mdSeconds).toInclude("**Duration**: 12s from team_create")

    const mdNeg = buildDissolveSummary({
      teamID: TEAM,
      tasks: [],
      engineers: [],
      durationMs: -1_000,
      dissolvedAt: FIXED_DISSOLVED_AT,
    })
    expect(mdNeg).toInclude("**Duration**: 0s from team_create")
  })
})
