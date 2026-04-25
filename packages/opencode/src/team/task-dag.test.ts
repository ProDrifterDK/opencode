/**
 * A4: Task DAG / Topological Scheduling Tests
 *
 * Covers:
 *  - Linear dependency chain: A → B → C (only A claimable initially)
 *  - Dependency on unknown id rejected at decompose time
 *  - Cycle (A → B → A) rejected at decompose time
 *  - team_assign does not auto-assign blocked tasks
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as LeadCoordinatorService, CyclicDependenciesError } from "./lead-coordinator"
import { Service as TaskBoardRepoService } from "./task-board"
import { LeadCoordinatorError } from "./lead-coordinator"
import type {
  Task,
  TaskBoardID,
  CreateTaskInput,
  UpdateTaskInput,
  TaskBoardFilter,
  TeamID,
  EngineerID,
} from "./task-board.sql"
import type { EngineerStateRecord } from "./types"

// ─── In-memory task board mock ────────────────────────────────────────────────

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
          assigned_engineer_id:
            input.assigned_engineer_id !== undefined
              ? input.assigned_engineer_id
              : existing.assigned_engineer_id,
          file_scope: input.file_scope !== undefined ? input.file_scope : existing.file_scope,
          blocked_by: input.blocked_by !== undefined ? input.blocked_by : existing.blocked_by,
          parent_task_id:
            input.parent_task_id !== undefined ? input.parent_task_id : existing.parent_task_id,
          completed_at:
            input.completed_at !== undefined ? input.completed_at : existing.completed_at,
          dependencies:
            input.dependencies !== undefined ? input.dependencies : existing.dependencies,
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
          if (filter.assigned_engineer_id && t.assigned_engineer_id !== filter.assigned_engineer_id)
            return false
          return true
        }),
      ),

    get: (taskId: TaskBoardID) => Effect.sync(() => tasks.get(taskId) ?? null),

    delete: (taskId: TaskBoardID) => Effect.sync(() => { tasks.delete(taskId) }),

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

    archiveTeamBoard: (_teamId: TeamID) => Effect.void,
    listArchived: (_teamId: TeamID) => Effect.succeed([]),
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEAM_ID = "team_dag_test" as TeamID

const makeEngineer = (
  suffix: string,
  state: EngineerStateRecord["state"] = "idle",
): EngineerStateRecord => ({
  engineerID: `eng_${suffix}` as EngineerID,
  name: `Engineer ${suffix}`,
  state,
  currentTask: undefined,
  lastHeartbeat: Date.now(),
})

// ─── Layer builder ────────────────────────────────────────────────────────────

import { layer as leadLayer } from "./lead-coordinator"

let memBoard: ReturnType<typeof makeMemoryTaskBoard>

const makeLayers = () => {
  memBoard = makeMemoryTaskBoard()
  const repoLayer = Layer.succeed(TaskBoardRepoService, memBoard)
  return leadLayer.pipe(Layer.provide(repoLayer))
}

const runWith = <A>(effect: Effect.Effect<A, any, LeadCoordinatorService>) => {
  const layers = makeLayers()
  return Effect.provide(effect, layers).pipe(Effect.runPromise)
}

const runWithCatch = <A>(effect: Effect.Effect<A, any, LeadCoordinatorService>) => {
  const layers = makeLayers()
  return Effect.provide(effect, layers).pipe(Effect.runPromiseExit)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task DAG — dependency validation at decompose", () => {
  test("rejects dependency referencing unknown client id", async () => {
    const exit = await runWithCatch(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService
        return yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "desc a", files: [] },
            {
              id: "b",
              title: "Task B",
              description: "desc b",
              files: [],
              dependencies: ["unknown-id"],
            },
          ],
        })
      }),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeString = JSON.stringify(exit.cause)
      expect(causeString).toContain("unknown id")
    }
  })

  test("rejects cycle A → B → A", async () => {
    const exit = await runWithCatch(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService
        return yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "desc a", files: [], dependencies: ["b"] },
            { id: "b", title: "Task B", description: "desc b", files: [], dependencies: ["a"] },
          ],
        })
      }),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeString = JSON.stringify(exit.cause)
      expect(causeString).toContain("yclic")
    }
  })

  test("rejects three-node cycle A → B → C → A", async () => {
    const exit = await runWithCatch(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService
        return yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "d", files: [], dependencies: ["c"] },
            { id: "b", title: "Task B", description: "d", files: [], dependencies: ["a"] },
            { id: "c", title: "Task C", description: "d", files: [], dependencies: ["b"] },
          ],
        })
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("accepts linear chain A → B → C (no cycle)", async () => {
    const tasks = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService
        return yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "first", files: ["a.ts"] },
            { id: "b", title: "Task B", description: "second", files: ["b.ts"], dependencies: ["a"] },
            {
              id: "c",
              title: "Task C",
              description: "third",
              files: ["c.ts"],
              dependencies: ["b"],
            },
          ],
        })
      }),
    )

    expect(tasks).toHaveLength(3)
    const taskA = tasks.find((t) => t.title === "Task A")!
    const taskB = tasks.find((t) => t.title === "Task B")!
    const taskC = tasks.find((t) => t.title === "Task C")!

    expect(taskA.dependencies).toHaveLength(0)
    expect(taskB.dependencies).toHaveLength(1)
    expect(taskB.dependencies[0]).toBe(taskA.id)
    expect(taskC.dependencies).toHaveLength(1)
    expect(taskC.dependencies[0]).toBe(taskB.id)
  })
})

describe("Task DAG — claimability (listReadyTasks)", () => {
  test("linear chain: only Task A is ready initially", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        const tasks = yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "first", files: ["a.ts"] },
            {
              id: "b",
              title: "Task B",
              description: "second",
              files: ["b.ts"],
              dependencies: ["a"],
            },
            {
              id: "c",
              title: "Task C",
              description: "third",
              files: ["c.ts"],
              dependencies: ["b"],
            },
          ],
        })

        const ready = yield* memBoard.listReadyTasks(TEAM_ID)
        return { tasks, ready }
      }),
    )

    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].title).toBe("Task A")
  })

  test("Task B becomes ready after A completes", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        const tasks = yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "first", files: ["a.ts"] },
            {
              id: "b",
              title: "Task B",
              description: "second",
              files: ["b.ts"],
              dependencies: ["a"],
            },
            {
              id: "c",
              title: "Task C",
              description: "third",
              files: ["c.ts"],
              dependencies: ["b"],
            },
          ],
        })

        const taskA = tasks.find((t) => t.title === "Task A")!

        // Complete Task A
        yield* memBoard.update(taskA.id, { status: "completed" })

        const ready = yield* memBoard.listReadyTasks(TEAM_ID)
        return { tasks, ready }
      }),
    )

    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].title).toBe("Task B")
  })

  test("Task C only ready after both A and B complete", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        const tasks = yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "first", files: ["a.ts"] },
            {
              id: "b",
              title: "Task B",
              description: "second",
              files: ["b.ts"],
              dependencies: ["a"],
            },
            {
              id: "c",
              title: "Task C",
              description: "third",
              files: ["c.ts"],
              dependencies: ["b"],
            },
          ],
        })

        const taskA = tasks.find((t) => t.title === "Task A")!
        const taskB = tasks.find((t) => t.title === "Task B")!

        yield* memBoard.update(taskA.id, { status: "completed" })
        yield* memBoard.update(taskB.id, { status: "completed" })

        const ready = yield* memBoard.listReadyTasks(TEAM_ID)
        return { tasks, ready }
      }),
    )

    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].title).toBe("Task C")
  })

  test("tasks with no dependencies are always ready", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "independent", files: ["a.ts"] },
            { id: "b", title: "Task B", description: "independent", files: ["b.ts"] },
          ],
        })

        return yield* memBoard.listReadyTasks(TEAM_ID)
      }),
    )

    expect(result).toHaveLength(2)
  })
})

describe("Task DAG — assign does not auto-assign blocked tasks", () => {
  test("assign skips tasks whose dependencies are not completed", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        const tasks = yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            { id: "a", title: "Task A", description: "first", files: ["a.ts"] },
            {
              id: "b",
              title: "Task B",
              description: "blocked by A",
              files: ["b.ts"],
              dependencies: ["a"],
            },
          ],
        })

        const engineers = [makeEngineer("1"), makeEngineer("2")]
        const assigned = yield* lead.assign({ teamId: TEAM_ID, engineers })

        return { tasks, assigned }
      }),
    )

    // Only Task A should be assigned (Task B depends on A which is not completed)
    expect(result.assigned).toHaveLength(1)
    expect(result.assigned[0].title).toBe("Task A")
  })

  test("assign returns empty when ALL tasks are blocked", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const lead = yield* LeadCoordinatorService

        const tasks = yield* lead.decompose({
          teamId: TEAM_ID,
          request: "test",
          subtasks: [
            // Seed a "virtual" task A by creating it first, then mark it as pending
            {
              id: "blocker",
              title: "Blocker",
              description: "must be done first",
              files: ["x.ts"],
            },
            {
              id: "b",
              title: "Task B",
              description: "blocked",
              files: ["b.ts"],
              dependencies: ["blocker"],
            },
          ],
        })

        // Mark Blocker as in-progress (claimed by someone), so only Task B is unclaimed/pending
        const blocker = tasks.find((t) => t.title === "Blocker")!
        yield* memBoard.update(blocker.id, {
          status: "in-progress",
          assigned_engineer_id: "eng_other" as EngineerID,
        })

        const engineers = [makeEngineer("1")]
        const assigned = yield* lead.assign({ teamId: TEAM_ID, engineers })

        return { assigned }
      }),
    )

    expect(result.assigned).toHaveLength(0)
  })
})
