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



  test("claims decomposed task when file scope order differs", () => {
    const task = { ...base, file_scope: '["src/b.ts","src/a.ts"]' }

    expect(resolveSpawnTaskCandidate({
      tasks: [task],
      task: {
        title: "Frontend Code Quality Review",
        description: "Review the frontend",
        fileScope: '["src/a.ts","src/b.ts"]',
      },
    })).toEqual({ kind: "claim", task })
  })

  test("treats null and empty file scopes as the same unscoped task", () => {
    const task = { ...base, file_scope: null }

    expect(resolveSpawnTaskCandidate({
      tasks: [task],
      task: {
        title: "Frontend Code Quality Review",
        description: "Review the frontend",
        fileScope: "[]",
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
