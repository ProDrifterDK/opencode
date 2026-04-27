import { describe, expect, test } from "bun:test"
import { buildEngineerReportMessage, buildTeamCompleteMessage, isTeamWorkComplete } from "./completion"

describe("team completion detection", () => {
  test("complete when every task completed and every engineer idle", () => {
    expect(isTeamWorkComplete({
      tasks: [{ status: "completed" }, { status: "completed" }],
      engineers: [{ state: "idle" }, { state: "idle" }],
    })).toBe(true)
  })

  test("not complete while any task is active or blocked", () => {
    expect(isTeamWorkComplete({
      tasks: [{ status: "completed" }, { status: "in-progress" }],
      engineers: [{ state: "idle" }, { state: "working" }],
    })).toBe(false)
    expect(isTeamWorkComplete({
      tasks: [{ status: "completed" }, { status: "blocked" }],
      engineers: [{ state: "idle" }, { state: "blocked" }],
    })).toBe(false)
  })

  test("not complete for empty teams", () => {
    expect(isTeamWorkComplete({ tasks: [], engineers: [{ state: "idle" }] })).toBe(false)
    expect(isTeamWorkComplete({ tasks: [{ status: "completed" }], engineers: [] })).toBe(false)
  })

  test("completion message tells lead the next action", () => {
    expect(buildTeamCompleteMessage({ teamID: "team_1", completedTasks: 2 })).toContain("team_commit")
  })

  test("engineer report message includes engineer, task, and summary", () => {
    const message = buildEngineerReportMessage({
      engineerName: "engineer-frontend",
      taskTitle: "Frontend Review",
      summary: "Report written to .tmp/report.md",
    })

    expect(message).toContain("Engineer engineer-frontend reports: COMPLETED")
    expect(message).toContain("Task: Frontend Review")
    expect(message).toContain("Summary: Report written to .tmp/report.md")
  })
})
