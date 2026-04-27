import { describe, expect, test } from "bun:test"
import type { Task, TaskBoardID, TeamID, EngineerID } from "./task-board.sql"
import { hasCompletedAssignedTask } from "./claim-policy"

const task = (status: Task["status"]): Task => ({
  id: `task-${status}` as TaskBoardID,
  team_id: "team-claim" as TeamID,
  title: status,
  description: null,
  status,
  assigned_engineer_id: "eng-claim" as EngineerID,
  file_scope: null,
  blocked_by: null,
  parent_task_id: null,
  dependencies: [],
  time_created: 1,
  time_updated: 1,
  completed_at: status === "completed" ? 2 : null,
  archived_at: null,
})

describe("team claim policy", () => {
  test("blocks engineers that already completed assigned work", () => {
    expect(hasCompletedAssignedTask([task("completed")])).toBe(true)
  })

  test("allows engineers without completed assigned work", () => {
    expect(hasCompletedAssignedTask([task("failed"), task("blocked")])).toBe(false)
    expect(hasCompletedAssignedTask([])).toBe(false)
  })
})
