import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and } from "drizzle-orm"
import { TaskBoardTable, type TaskBoardID, type TeamID } from "../../src/team/task-board.sql"

let sqlite: Database
let db: SQLiteBunDatabase

beforeEach(() => {
  sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  db = drizzle({ client: sqlite })

  migrate(db, [{
    sql: "CREATE TABLE task_board (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, assigned_engineer_id TEXT, file_scope TEXT, blocked_by TEXT, parent_task_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, completed_at INTEGER)",
    timestamp: 1,
    name: "init"
  }])
})

afterEach(() => {
  sqlite.close()
})

describe("TaskBoardRepo", () => {
  test("create, get, update, list, delete lifecycle", () => {
    const teamId = "team-123" as TeamID
    const id = crypto.randomUUID() as TaskBoardID
    const now = Date.now()

    db.insert(TaskBoardTable).values({
      id,
      team_id: teamId,
      title: "Test Task",
      description: null,
      status: "pending",
      assigned_engineer_id: null,
      file_scope: null,
      blocked_by: null,
      parent_task_id: null,
      time_created: now,
      time_updated: now,
      completed_at: null,
    }).run()

    const fetched = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, id)).get()
    expect(fetched?.title).toBe("Test Task")
    expect(fetched?.status).toBe("pending")

    db.update(TaskBoardTable).set({ status: "in-progress", time_updated: Date.now() })
      .where(eq(TaskBoardTable.id, id)).run()

    const updated = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, id)).get()
    expect(updated?.status).toBe("in-progress")

    const listed = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.team_id, teamId)).all()
    expect(listed.length).toBe(1)

    db.delete(TaskBoardTable).where(eq(TaskBoardTable.id, id)).run()

    const afterDelete = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, id)).get()
    expect(afterDelete).toBeUndefined()
  })

  test("create with all fields", () => {
    const teamId = "team-456" as TeamID
    const parentId = "parent-123" as TaskBoardID
    const id = crypto.randomUUID() as TaskBoardID
    const now = Date.now()

    db.insert(TaskBoardTable).values({
      id,
      team_id: teamId,
      title: "Full Task",
      description: "A description",
      status: "blocked",
      assigned_engineer_id: "engineer-1",
      file_scope: "src/**/*.ts",
      blocked_by: parentId,
      parent_task_id: parentId,
      time_created: now,
      time_updated: now,
      completed_at: null,
    } as any).run()

    const fetched = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, id)).get()
    expect(fetched?.description).toBe("A description")
    expect(fetched?.status).toBe("blocked")
    expect(fetched?.assigned_engineer_id as string).toBe("engineer-1")
    expect(fetched?.file_scope).toBe("src/**/*.ts")
    expect(fetched?.blocked_by).toBe(parentId)
  })

  test("update only title preserves description", () => {
    const teamId = "team-789" as TeamID
    const id = crypto.randomUUID() as TaskBoardID
    const now = Date.now()

    db.insert(TaskBoardTable).values({
      id,
      team_id: teamId,
      title: "Original",
      description: "Keep me",
      status: "pending",
      assigned_engineer_id: null,
      file_scope: null,
      blocked_by: null,
      parent_task_id: null,
      time_created: now,
      time_updated: now,
      completed_at: null,
    }).run()

    db.update(TaskBoardTable).set({ title: "Updated", time_updated: Date.now() })
      .where(eq(TaskBoardTable.id, id)).run()

    const updated = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, id)).get()
    expect(updated?.title).toBe("Updated")
    expect(updated?.description).toBe("Keep me")
  })

  test("list with status filter", () => {
    const teamId = "team-filter" as TeamID
    const now = Date.now()

    db.insert(TaskBoardTable).values({
      id: crypto.randomUUID() as TaskBoardID,
      team_id: teamId,
      title: "Task 1",
      status: "pending",
      time_created: now,
      time_updated: now,
    }).run()
    db.insert(TaskBoardTable).values({
      id: crypto.randomUUID() as TaskBoardID,
      team_id: teamId,
      title: "Task 2",
      status: "in-progress",
      time_created: now,
      time_updated: now,
    }).run()
    db.insert(TaskBoardTable).values({
      id: crypto.randomUUID() as TaskBoardID,
      team_id: teamId,
      title: "Task 3",
      status: "pending",
      time_created: now,
      time_updated: now,
    }).run()

    const all = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.team_id, teamId)).all()
    expect(all.length).toBe(3)

    const pending = db.select().from(TaskBoardTable).where(
      and(eq(TaskBoardTable.team_id, teamId), eq(TaskBoardTable.status, "pending"))
    ).all()
    expect(pending.length).toBe(2)
    expect(pending.every((t) => t.status === "pending")).toBe(true)
  })
})