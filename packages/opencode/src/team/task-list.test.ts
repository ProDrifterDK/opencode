import { describe, expect, test } from "bun:test"
import { buildReviewPacket, encodeReviewPacket } from "./review-packet"
import { computeTaskWarnings, decodeTaskFileScope, renderTaskList } from "./task-list"
import type { EngineerID } from "./types"
import type { Task, TaskBoardID, TeamID } from "./task-board.sql"

const TEAM_ID = "team_render" as TeamID

const makeTask = (input: {
  id: string
  title: string
  fileScope?: string[]
  status?: Task["status"]
  assignedEngineerID?: string | null
  reviewPacket?: string | null
}): Task => ({
  id: input.id as TaskBoardID,
  team_id: TEAM_ID,
  title: input.title,
  description: `${input.title} description`,
  status: input.status ?? "pending",
  assigned_engineer_id: input.assignedEngineerID === undefined
    ? null
    : input.assignedEngineerID === null
      ? null
      : input.assignedEngineerID as EngineerID,
  file_scope: input.fileScope ? JSON.stringify(input.fileScope) : null,
  blocked_by: null,
  parent_task_id: null,
  dependencies: [],
  time_created: 1,
  time_updated: 1,
  completed_at: null,
  archived_at: null,
  review_packet: input.reviewPacket ?? null,
})

describe("team task list rendering", () => {
  test("decodes file scopes defensively", () => {
    expect(decodeTaskFileScope('["src/a.ts",123,null,"src/b.ts"]')).toEqual(["src/a.ts", "src/b.ts"])
    expect(decodeTaskFileScope("not-json")).toEqual([])
  })

  test("computes coordination warnings with human task titles", () => {
    const frontend = makeTask({ id: "task_frontend", title: "Frontend review", fileScope: ["src/**"] })
    const backend = makeTask({ id: "task_backend", title: "Backend review", fileScope: ["src/api/**"] })

    const warnings = computeTaskWarnings({ task: frontend, tasks: [frontend, backend] })

    expect(warnings).toHaveLength(1)
    expect(warnings[0].task).toBe("Frontend review")
    expect(warnings[0].conflictsWith).toBe("Backend review")
    expect(warnings[0].message).toContain('"Frontend review" overlaps with "Backend review"')
    expect(warnings[0].message).not.toContain("task_backend")
  })

  test("renders file scopes, coordination warnings, and review packets", () => {
    const frontend = makeTask({
      id: "task_frontend",
      title: "Frontend review",
      fileScope: ["src/**"],
      status: "in-progress",
      assignedEngineerID: "eng_frontend",
      reviewPacket: encodeReviewPacket(buildReviewPacket({
        status: "completed",
        summary: "Reviewed frontend. Tests passed.",
        reportPath: ".tmp/report-frontend.md",
        changedFiles: [".tmp/report-frontend.md"],
        verificationCommands: ["bun test src/frontend.test.ts"],
        knownGaps: [],
        confidence: "high",
      })),
    })
    const backend = makeTask({
      id: "task_backend",
      title: "Backend review",
      fileScope: ["src/api/**"],
      status: "in-progress",
      assignedEngineerID: "eng_backend",
    })

    const rendered = renderTaskList({ tasks: [frontend, backend], allTasks: [frontend, backend], showAll: true })

    expect(rendered.output).toContain("File scope: src/**")
    expect(rendered.output).toContain('Coordination warnings: Coordinate before editing overlapping file scopes: "Frontend review" overlaps with "Backend review".')
    expect(rendered.output).toContain("Report: .tmp/report-frontend.md")
    expect(rendered.output).toContain("Verification: bun test src/frontend.test.ts")
    expect(rendered.metadataTasks[0].fileScope).toEqual(["src/**"])
    expect(rendered.metadataTasks[0].coordinationWarnings[0].conflictsWith).toBe("Backend review")
    expect(rendered.metadataTasks[0].reviewPacket?.reportPath).toBe(".tmp/report-frontend.md")
  })
})
