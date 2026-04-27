import { describe, expect, test } from "bun:test"
import { resolveSpawnTaskCandidate } from "./spawn-task"
import type { TaskBoardID } from "./task-board.sql"

const base = {
  id: "task_frontend" as TaskBoardID,
  title: "Frontend Code Quality Review",
  description: "Review the frontend",
  file_scope: '["src/**"]',
  status: "pending" as const,
  assigned_engineer_id: null,
}

describe("team_spawn task matching", () => {
  test("claims the existing decomposed task instead of creating a duplicate", () => {
    const task = { ...base }

    expect(resolveSpawnTaskCandidate({
      tasks: [task],
      task: {
        title: "Frontend Code Quality Review",
        description: "Review the frontend",
        fileScope: '["src/**"]',
      },
    })).toEqual({ kind: "claim", task })
  })

  test("creates a new task when no pending unassigned task matches exactly", () => {
    expect(resolveSpawnTaskCandidate({
      tasks: [{ ...base, status: "completed" }],
      task: {
        title: "Frontend Code Quality Review",
        description: "Review the frontend",
        fileScope: '["src/**"]',
      },
    })).toEqual({ kind: "create" })
  })

  test("fails ambiguous exact matches instead of choosing silently", () => {
    expect(resolveSpawnTaskCandidate({
      tasks: [{ ...base }, { ...base }],
      task: {
        title: "Frontend Code Quality Review",
        description: "Review the frontend",
        fileScope: '["src/**"]',
      },
    })).toEqual({ kind: "ambiguous", count: 2 })
  })
})
