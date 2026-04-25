import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as TaskBoardRepoService } from "./task-board"
import { Service as TaskBoardSvcService } from "./task-board-service"
import type { Task, TaskBoardID, CreateTaskInput, UpdateTaskInput, TaskBoardFilter, TeamID, EngineerID, TaskStatus } from "./task-board.sql"

const makeMemoryTaskBoard = () => {
  let tasks = new Map<string, Task>()
  let idCounter = 0
  const nextId = () => `task_${++idCounter}` as TaskBoardID

  return TaskBoardRepoService.of({
    create: (input: CreateTaskInput) =>
      Effect.sync(() => {
        const id = nextId()
        const now = Date.now()
        const task: Task = {
          id,
          team_id: input.team_id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "pending",
          assigned_engineer_id: input.assigned_engineer_id ?? null,
          file_scope: input.file_scope ?? null,
          blocked_by: input.blocked_by ?? null,
          parent_task_id: input.parent_task_id ?? null,
          dependencies: input.dependencies ?? [],
          time_created: now,
          time_updated: now,
          completed_at: null,
        }
        tasks.set(id, task)
        return task
      }),

    update: (taskId: TaskBoardID, input: UpdateTaskInput) =>
      Effect.sync(() => {
        const existing = tasks.get(taskId)
        if (!existing) throw new Error(`Task not found: ${taskId}`)
        const updated: Task = {
          ...existing,
          title: input.title ?? existing.title,
          description: input.description !== undefined ? input.description : existing.description,
          status: input.status ?? existing.status,
          assigned_engineer_id: input.assigned_engineer_id !== undefined ? input.assigned_engineer_id : existing.assigned_engineer_id,
          file_scope: input.file_scope !== undefined ? input.file_scope : existing.file_scope,
          blocked_by: input.blocked_by !== undefined ? input.blocked_by : existing.blocked_by,
          parent_task_id: input.parent_task_id !== undefined ? input.parent_task_id : existing.parent_task_id,
          completed_at: input.completed_at !== undefined ? input.completed_at : existing.completed_at,
          dependencies: input.dependencies !== undefined ? input.dependencies : existing.dependencies,
          time_updated: Date.now(),
        }
        tasks.set(taskId, updated)
        return updated
      }),

    list: (filter: TaskBoardFilter) =>
      Effect.sync(() =>
        [...tasks.values()].filter((t) => {
          if (t.team_id !== filter.team_id) return false
          if (filter.status && t.status !== filter.status) return false
          if (filter.assigned_engineer_id && t.assigned_engineer_id !== filter.assigned_engineer_id) return false
          return true
        }),
      ),

    get: (taskId: TaskBoardID) =>
      Effect.sync(() => tasks.get(taskId) ?? null),

    delete: (taskId: TaskBoardID) =>
      Effect.sync(() => { tasks.delete(taskId) }),

    listReadyTasks: (teamId: TeamID) =>
      Effect.sync(() => {
        const all = [...tasks.values()].filter((t) => t.team_id === teamId)
        const completedIds = new Set(all.filter((t) => t.status === "completed").map((t) => t.id))
        return all.filter(
          (t) =>
            t.status === "pending" &&
            !t.assigned_engineer_id &&
            t.dependencies.every((depId) => completedIds.has(depId)),
        )
      }),
  })
}

const TEAM_ID = "team_test" as TeamID
const LEAD_ID = "eng_lead" as EngineerID
const ENG_A = "eng_a" as EngineerID
const ENG_B = "eng_b" as EngineerID

let memBoard: ReturnType<typeof makeMemoryTaskBoard>

const refreshBoard = () => {
  memBoard = makeMemoryTaskBoard()
  return Layer.succeed(TaskBoardRepoService, memBoard)
}

import { layer as serviceLayer } from "./task-board-service"

const makeLayers = () => {
  const repoLayer = refreshBoard()
  return serviceLayer.pipe(Layer.provide(repoLayer))
}

const runWith = <A>(
  effect: Effect.Effect<A, any, TaskBoardSvcService>,
) =>
  Effect.provide(effect, makeLayers()).pipe(Effect.runPromise)

const runWithBoth = <A>(
  effect: Effect.Effect<A, any, TaskBoardSvcService | TaskBoardRepoService>,
) => {
  const repoLayer = refreshBoard()
  const svcLayer = serviceLayer.pipe(Layer.provide(repoLayer))
  return effect.pipe(
    Effect.provide(svcLayer),
    Effect.provide(repoLayer),
  ).pipe(Effect.runPromise)
}

describe("TaskBoardService", () => {
  test("createTask creates a task", async () => {
    const task = await runWith(
      Effect.gen(function* () {
        const svc = yield* TaskBoardSvcService
        return yield* svc.createTask({
          team_id: TEAM_ID,
          title: "Test task",
          description: "A test",
        })
      }),
    )
    expect(task.title).toBe("Test task")
    expect(task.status).toBe("pending")
    expect(task.assigned_engineer_id).toBeNull()
  })

  test("createTask rejects when board is full", async () => {
    const result = runWith(
      Effect.gen(function* () {
        const svc = yield* TaskBoardSvcService
        for (let i = 0; i < 100; i++) {
          yield* svc.createTask({ team_id: TEAM_ID, title: `Task ${i}` })
        }
        return yield* svc.createTask({ team_id: TEAM_ID, title: "Overflow" })
      }),
    )
    await expect(result).rejects.toThrow("Task board full")
  })

  test("updateTaskStatus: owner can transition pending→in-progress", async () => {
    const { task, updated } = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Owned task",
          status: "pending",
          assigned_engineer_id: ENG_A,
        })
        const updated = yield* svc.updateTaskStatus(task.id, ENG_A, false, "in-progress")
        return { task, updated }
      }),
    )
    expect(updated.status).toBe("in-progress")
  })

  test("updateTaskStatus: non-owner denied", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Owned by A",
          status: "pending",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.updateTaskStatus(task.id, ENG_B, false, "in-progress")
      }),
    )
    await expect(result).rejects.toThrow("Ownership denied")
  })

  test("updateTaskStatus: lead can update any task", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Lead override",
          status: "pending",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, LEAD_ID, true, "in-progress")
      }),
    )
    expect(updated.status).toBe("in-progress")
  })

  test("updateTaskStatus: invalid transition rejected", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Completed task",
          status: "completed",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.updateTaskStatus(task.id, ENG_A, false, "pending")
      }),
    )
    await expect(result).rejects.toThrow("Invalid status transition")
  })

  test("updateTaskStatus: completed→pending rejected", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Done",
          status: "completed",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.updateTaskStatus(task.id, ENG_A, false, "pending")
      }),
    )
    await expect(result).rejects.toThrow("Invalid status transition")
  })

  test("updateTaskStatus: in-progress→completed OK", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Finishing",
          status: "in-progress",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, ENG_A, false, "completed")
      }),
    )
    expect(updated.status).toBe("completed")
  })

  test("updateTaskStatus: in-progress→failed OK", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Failing",
          status: "in-progress",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, ENG_A, false, "failed")
      }),
    )
    expect(updated.status).toBe("failed")
  })

  test("updateTaskStatus: in-progress→blocked OK", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Blocked",
          status: "in-progress",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, ENG_A, false, "blocked")
      }),
    )
    expect(updated.status).toBe("blocked")
  })

  test("updateTaskStatus: blocked→in-progress OK", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Unblocking",
          status: "blocked",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, ENG_A, false, "in-progress")
      }),
    )
    expect(updated.status).toBe("in-progress")
  })

  test("updateTaskStatus: blocked→failed OK", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Blocked fail",
          status: "blocked",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTaskStatus(task.id, ENG_A, false, "failed")
      }),
    )
    expect(updated.status).toBe("failed")
  })

  test("assignTask: lead can assign", async () => {
    const assigned = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Assignable",
          status: "pending",
        })
        return yield* svc.assignTask(task.id, LEAD_ID, true, ENG_A)
      }),
    )
    expect(assigned.assigned_engineer_id).toBe(ENG_A)
    expect(assigned.status).toBe("in-progress")
  })

  test("assignTask: engineer cannot assign", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Nope",
          status: "pending",
        })
        yield* svc.assignTask(task.id, ENG_A, false, ENG_B)
      }),
    )
    await expect(result).rejects.toThrow("only lead can assign")
  })

  test("listTasks returns filtered tasks", async () => {
    const tasks = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        yield* repo.create({ team_id: TEAM_ID, title: "A", status: "pending" })
        yield* repo.create({ team_id: TEAM_ID, title: "B", status: "in-progress", assigned_engineer_id: ENG_A })
        return yield* svc.listTasks({ team_id: TEAM_ID })
      }),
    )
    expect(tasks).toHaveLength(2)
  })

  test("getTask returns task by id", async () => {
    const { found, missing } = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({ team_id: TEAM_ID, title: "Find me" })
        const found = yield* svc.getTask(task.id)
        const missing = yield* svc.getTask("nonexistent" as TaskBoardID)
        return { found, missing }
      }),
    )
    expect(found).not.toBeNull()
    expect(found!.title).toBe("Find me")
    expect(missing).toBeNull()
  })

  test("deleteTask: lead can delete any", async () => {
    const { task, afterDelete } = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Deletable",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.deleteTask(task.id, LEAD_ID, true)
        const afterDelete = yield* repo.get(task.id)
        return { task, afterDelete }
      }),
    )
    expect(afterDelete).toBeNull()
  })

  test("deleteTask: owner can delete own", async () => {
    const afterDelete = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Own delete",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.deleteTask(task.id, ENG_A, false)
        return yield* repo.get(task.id)
      }),
    )
    expect(afterDelete).toBeNull()
  })

  test("deleteTask: non-owner denied", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Protected",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.deleteTask(task.id, ENG_B, false)
      }),
    )
    await expect(result).rejects.toThrow("Ownership denied")
  })

  test("updateTask: owner can update title", async () => {
    const updated = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Old title",
          assigned_engineer_id: ENG_A,
        })
        return yield* svc.updateTask(task.id, ENG_A, false, { title: "New title" })
      }),
    )
    expect(updated.title).toBe("New title")
  })

  test("updateTask: non-owner denied", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const task = yield* repo.create({
          team_id: TEAM_ID,
          title: "Owned",
          assigned_engineer_id: ENG_A,
        })
        yield* svc.updateTask(task.id, ENG_B, false, { title: "Hacked" })
      }),
    )
    await expect(result).rejects.toThrow("Ownership denied")
  })

  test("createMultiple creates batch", async () => {
    const tasks = await runWith(
      Effect.gen(function* () {
        const svc = yield* TaskBoardSvcService
        return yield* svc.createMultiple([
          { team_id: TEAM_ID, title: "Batch 1" },
          { team_id: TEAM_ID, title: "Batch 2" },
          { team_id: TEAM_ID, title: "Batch 3" },
        ])
      }),
    )
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.title)).toEqual(["Batch 1", "Batch 2", "Batch 3"])
  })

  test("createMultiple rejects when would exceed limit", async () => {
    const result = runWith(
      Effect.gen(function* () {
        const svc = yield* TaskBoardSvcService
        for (let i = 0; i < 99; i++) {
          yield* svc.createTask({ team_id: TEAM_ID, title: `Fill ${i}` })
        }
        yield* svc.createMultiple([
          { team_id: TEAM_ID, title: "A" },
          { team_id: TEAM_ID, title: "B" },
        ])
      }),
    )
    await expect(result).rejects.toThrow("Task board full")
  })

  test("updateMultiple updates batch with ownership check", async () => {
    const results = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const t1 = yield* repo.create({ team_id: TEAM_ID, title: "U1", status: "pending", assigned_engineer_id: ENG_A })
        const t2 = yield* repo.create({ team_id: TEAM_ID, title: "U2", status: "pending", assigned_engineer_id: ENG_A })
        return yield* svc.updateMultiple(
          [
            { taskId: t1.id, input: { status: "in-progress" } },
            { taskId: t2.id, input: { status: "in-progress" } },
          ],
          ENG_A,
          false,
        )
      }),
    )
    expect(results).toHaveLength(2)
    expect(results.every((t) => t.status === "in-progress")).toBe(true)
  })

  test("updateMultiple: non-owner batch denied", async () => {
    const result = runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        const t1 = yield* repo.create({ team_id: TEAM_ID, title: "U1", status: "pending", assigned_engineer_id: ENG_A })
        yield* svc.updateMultiple(
          [{ taskId: t1.id, input: { status: "in-progress" } }],
          ENG_B,
          false,
        )
      }),
    )
    await expect(result).rejects.toThrow("Ownership denied")
  })

  test("listByStatus filters correctly", async () => {
    const blocked = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        yield* repo.create({ team_id: TEAM_ID, title: "P1", status: "pending" })
        yield* repo.create({ team_id: TEAM_ID, title: "B1", status: "blocked" })
        yield* repo.create({ team_id: TEAM_ID, title: "B2", status: "blocked" })
        return yield* svc.listByStatus(TEAM_ID, "blocked")
      }),
    )
    expect(blocked).toHaveLength(2)
    expect(blocked.every((t) => t.status === "blocked")).toBe(true)
  })

  test("listByEngineer filters correctly", async () => {
    const engATasks = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        yield* repo.create({ team_id: TEAM_ID, title: "A1", assigned_engineer_id: ENG_A })
        yield* repo.create({ team_id: TEAM_ID, title: "B1", assigned_engineer_id: ENG_B })
        yield* repo.create({ team_id: TEAM_ID, title: "A2", assigned_engineer_id: ENG_A })
        return yield* svc.listByEngineer(TEAM_ID, ENG_A)
      }),
    )
    expect(engATasks).toHaveLength(2)
    expect(engATasks.every((t) => t.assigned_engineer_id === ENG_A)).toBe(true)
  })

  test("listBlocked returns only blocked tasks", async () => {
    const blocked = await runWithBoth(
      Effect.gen(function* () {
        const repo = yield* TaskBoardRepoService
        const svc = yield* TaskBoardSvcService
        yield* repo.create({ team_id: TEAM_ID, title: "OK", status: "in-progress" })
        yield* repo.create({ team_id: TEAM_ID, title: "STUCK", status: "blocked" })
        return yield* svc.listBlocked(TEAM_ID)
      }),
    )
    expect(blocked).toHaveLength(1)
    expect(blocked[0].title).toBe("STUCK")
  })
})
