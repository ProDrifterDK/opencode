import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as TaskBoardRepoService } from "./task-board"
import { Service as RateLimiterService } from "./rate-limiter"
import type { RateLimiterStats } from "./rate-limiter"
import type { Task, TaskBoardID, CreateTaskInput, UpdateTaskInput, TaskBoardFilter, TeamID, EngineerID } from "./task-board.sql"
import type { EngineerStateRecord } from "./types"

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

    archiveTeamBoard: (_teamId: TeamID) => Effect.void,
    listArchived: (_teamId: TeamID) => Effect.succeed([]),
  })
}

const TEAM_ID = "team_test" as TeamID

const makeEngineer = (suffix: string, state: EngineerStateRecord["state"] = "idle"): EngineerStateRecord => ({
  engineerID: `eng_${suffix}` as EngineerID,
  name: `Engineer ${suffix}`,
  state,
  currentTask: undefined,
  lastHeartbeat: Date.now(),
})

const memBoard = makeMemoryTaskBoard()
const testTaskBoardLayer = Layer.succeed(TaskBoardRepoService, memBoard)

const makeMemoryRateLimiter = (statsOverride?: RateLimiterStats | null) => {
  const statsMap = new Map<string, RateLimiterStats>()
  if (statsOverride !== undefined) {
    // Will be returned for any teamID if set
    statsMap.set("__default__", statsOverride as RateLimiterStats)
  }
  return RateLimiterService.of({
    acquire: () => Effect.void,
    release: () => Effect.void,
    report429: () => Effect.void,
    resetCircuitBreaker: () => Effect.void,
    getStats: (teamID: string) => statsMap.get(teamID) ?? statsMap.get("__default__") ?? null,
    forgetTeam: () => {},
  })
}

const testRateLimiterLayer = Layer.succeed(RateLimiterService, makeMemoryRateLimiter())

import { layer as leadLayer } from "./lead-coordinator"

const resolvedLead = leadLayer.pipe(
  Layer.provide(Layer.merge(testTaskBoardLayer, testRateLimiterLayer)),
)

const runWith = <A>(
  effect: Effect.Effect<A, any, LeadCoordinatorService>,
) =>
  Effect.provide(effect, resolvedLead).pipe(Effect.runPromise)

const runWithBoth = <A>(
  effect: Effect.Effect<A, any, LeadCoordinatorService | TaskBoardRepoService>,
) =>
  effect.pipe(
    Effect.provide(resolvedLead),
    Effect.provide(testTaskBoardLayer),
  ).pipe(Effect.runPromise)

const runWithCatch = <A>(
  effect: Effect.Effect<A, any, LeadCoordinatorService>,
) =>
  Effect.provide(effect, resolvedLead).pipe(Effect.runPromise)

describe("LeadCoordinator", () => {
  beforeEach(() => {
    const board = makeMemoryTaskBoard()
    Object.assign(memBoard, board)
  })

  test("decompose creates tasks with exclusive file scopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const tasks = await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "implement auth",
        subtasks: [
          { title: "Auth model", description: "Create auth types", files: ["src/auth/model.ts", "src/auth/types.ts"] },
          { title: "Auth routes", description: "Create auth endpoints", files: ["src/auth/routes.ts", "src/auth/handlers.ts"] },
          { title: "Auth tests", description: "Test auth", files: ["src/auth/model.test.ts"] },
        ],
      }),
    )

    expect(tasks).toHaveLength(3)
    expect(tasks[0].title).toBe("Auth model")
    expect(tasks[0].file_scope).toBe('["src/auth/model.ts","src/auth/types.ts"]')
    expect(tasks[1].title).toBe("Auth routes")
    expect(tasks[1].file_scope).toBe('["src/auth/routes.ts","src/auth/handlers.ts"]')
    expect(tasks[2].title).toBe("Auth tests")
    expect(tasks.every((t) => t.status === "pending")).toBe(true)
    expect(tasks.every((t) => t.assigned_engineer_id === null)).toBe(true)
  })

  test("decompose rejects overlapping file scopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const result = runWithCatch(
      service.decompose({
        teamId: TEAM_ID,
        request: "broken",
        subtasks: [
          { title: "Task A", description: "a", files: ["src/foo.ts"] },
          { title: "Task B", description: "b", files: ["src/foo.ts", "src/bar.ts"] },
        ],
      }),
    )

    await expect(result).rejects.toThrow("Overlapping fileScopes detected")
  })

  test("rejects fileScopes overlapping via globs (e.g. src/** vs src/auth/**)", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const result = runWithCatch(
      service.decompose({
        teamId: "team_t1" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: ["src/**"] },
          { id: "b", title: "B", description: "", files: ["src/auth/**"] },
        ],
      }),
    )

    await expect(result).rejects.toThrow("Overlapping fileScopes detected")
  })

  test("collects all overlapping pairs when 3+ subtasks overlap", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const result = runWithCatch(
      service.decompose({
        teamId: "team_t2" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: ["src/**"] },
          { id: "b", title: "B", description: "", files: ["src/auth/**"] },
          { id: "c", title: "C", description: "", files: ["src/billing/**"] },
        ],
      }),
    )

    await expect(result).rejects.toMatchObject({
      _tag: "FileScopeConflictError",
      message: expect.stringMatching(/"a" vs "b"[\s\S]+"a" vs "c"/),
    })
  })

  test("accepts disjoint glob fileScopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const tasks = await runWith(
      service.decompose({
        teamId: "team_t3" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: ["src/auth/**"] },
          { id: "b", title: "B", description: "", files: ["src/billing/**"] },
        ],
      }),
    )
    expect(tasks.length).toBe(2)
  })

  test("accepts single-task decompose with no pairs to compare", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const tasks = await runWith(
      service.decompose({
        teamId: "team_t4" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "Solo", description: "", files: ["src/**"] },
        ],
      }),
    )
    expect(tasks.length).toBe(1)
  })

  test("treats empty fileScope arrays as non-overlapping", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const tasks = await runWith(
      service.decompose({
        teamId: "team_t5" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: [] },
          { id: "b", title: "B", description: "", files: [] },
        ],
      }),
    )
    expect(tasks.length).toBe(2)
  })

  test("assign distributes tasks to idle engineers with exclusive scopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "implement auth",
        subtasks: [
          { title: "Auth model", description: "Create auth types", files: ["src/auth/model.ts"] },
          { title: "Auth routes", description: "Create auth endpoints", files: ["src/auth/routes.ts"] },
        ],
      }),
    )

    const engineers = [makeEngineer("a"), makeEngineer("b"), makeEngineer("c")]
    const assigned = await runWith(service.assign({ teamId: TEAM_ID, engineers }))

    expect(assigned).toHaveLength(2)
    expect(assigned[0].assigned_engineer_id).toBe("eng_a" as EngineerID)
    expect(assigned[0].status).toBe("in-progress")
    expect(assigned[1].assigned_engineer_id).toBe("eng_b" as EngineerID)
    expect(assigned[1].status).toBe("in-progress")
  })

  test("assign respects MAX_TEAM_SIZE", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "big feature",
        subtasks: Array.from({ length: 6 }, (_, i) => ({
          title: `Task ${i}`,
          description: `desc ${i}`,
          files: [`src/file${i}.ts`],
        })),
      }),
    )

    const engineers = Array.from({ length: 6 }, (_, i) => makeEngineer(String(i)))
    const assigned = await runWith(service.assign({ teamId: TEAM_ID, engineers }))

    expect(assigned).toHaveLength(5)
  })

  test("assign skips engineers when file scope conflicts", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "setup",
        subtasks: [{ title: "Existing task", description: "taken", files: ["src/shared.ts"] }],
      }),
    )

    const tasksBefore = await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        return yield* tb.list({ team_id: TEAM_ID })
      }),
    )
    await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        yield* tb.update(tasksBefore[0].id, {
          assigned_engineer_id: "eng_a" as EngineerID,
          status: "in-progress",
        })
      }),
    )

    await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "more work",
        subtasks: [{ title: "New task", description: "conflicts", files: ["src/shared.ts"] }],
      }),
    )

    const engineers = [makeEngineer("a", "working"), makeEngineer("b")]
    const assigned = await runWith(service.assign({ teamId: TEAM_ID, engineers }))

    expect(assigned).toHaveLength(1)
    expect(assigned[0].assigned_engineer_id).toBe("eng_b" as EngineerID)
    expect(assigned[0].title).toBe("New task")
  })

  test("monitor returns correct progress report", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    await runWith(
      service.decompose({
        teamId: TEAM_ID,
        request: "feature",
        subtasks: [
          { title: "Task 1", description: "a", files: ["src/a.ts"] },
          { title: "Task 2", description: "b", files: ["src/b.ts"] },
          { title: "Task 3", description: "c", files: ["src/c.ts"] },
        ],
      }),
    )

    await runWith(
      service.assign({ teamId: TEAM_ID, engineers: [makeEngineer("x"), makeEngineer("y")] }),
    )

    await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        const all = yield* tb.list({ team_id: TEAM_ID })
        const first = all.find((t) => t.assigned_engineer_id === "eng_x" as EngineerID)!
        yield* tb.update(first.id, { status: "completed", completed_at: Date.now() })
        const second = all.find((t) => t.assigned_engineer_id === "eng_y" as EngineerID)!
        yield* tb.update(second.id, { status: "failed" })
      }),
    )

    const report = await runWith(service.monitor(TEAM_ID))

    expect(report.totalTasks).toBe(3)
    expect(report.completed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.pending).toBe(1)
    expect(report.inProgress).toBe(0)
    expect(report.engineers).toHaveLength(2)
  })

  test("monitor detects blockers", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        const blocker = yield* tb.create({
          team_id: TEAM_ID,
          title: "Blocker",
          description: "blocks others",
          file_scope: '["src/x.ts"]',
          status: "in-progress",
          assigned_engineer_id: "eng_a" as EngineerID,
        })
        yield* tb.create({
          team_id: TEAM_ID,
          title: "Blocked task",
          description: "waiting",
          file_scope: '["src/y.ts"]',
          status: "blocked",
          blocked_by: blocker.id,
          assigned_engineer_id: "eng_b" as EngineerID,
        })
      }),
    )

    const report = await runWith(service.monitor(TEAM_ID))
    expect(report.blockers).toHaveLength(1)
    expect(report.blockers[0].title).toBe("Blocked task")
  })

  test("reassign moves task to a new engineer", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const tasks = await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        return yield* tb.create({
          team_id: TEAM_ID,
          title: "Failed task",
          description: "engineer died",
          file_scope: '["src/auth.ts"]',
          status: "in-progress",
          assigned_engineer_id: "eng_failed" as EngineerID,
        })
      }),
    )

    const reassigned = await runWith(
      service.reassign({ taskId: tasks.id, toEngineer: "eng_backup" as EngineerID }),
    )

    expect(reassigned.assigned_engineer_id).toBe("eng_backup" as EngineerID)
    expect(reassigned.status).toBe("in-progress")
    expect(reassigned.title).toBe("Failed task")
  })

  test("reassign rejects if target engineer has file conflict", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const taskToReassign = await runWithBoth(
      Effect.gen(function* () {
        const tb = yield* TaskBoardRepoService
        yield* tb.create({
          team_id: TEAM_ID,
          title: "Active task on backup",
          description: "backup is busy",
          file_scope: '["src/auth.ts"]',
          status: "in-progress",
          assigned_engineer_id: "eng_backup" as EngineerID,
        })
        return yield* tb.create({
          team_id: TEAM_ID,
          title: "To reassign",
          description: "from failed eng",
          file_scope: '["src/auth.ts"]',
          status: "in-progress",
          assigned_engineer_id: "eng_failed" as EngineerID,
        })
      }),
    )

    const result = runWithCatch(
      service.reassign({ taskId: taskToReassign.id, toEngineer: "eng_backup" as EngineerID }),
    )

    await expect(result).rejects.toThrow("file conflict")
  })

  test("validateFileScopes returns true for exclusive scopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const valid = await runWith(
      service.validateFileScopes([
        { id: "1", files: ["src/a.ts", "src/b.ts"] },
        { id: "2", files: ["src/c.ts", "src/d.ts"] },
      ]),
    )
    expect(valid).toBe(true)
  })

  test("validateFileScopes returns false for overlapping scopes", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const valid = await runWith(
      service.validateFileScopes([
        { id: "1", files: ["src/a.ts", "src/b.ts"] },
        { id: "2", files: ["src/b.ts", "src/c.ts"] },
      ]),
    )
    expect(valid).toBe(false)
  })

  test("formatStatus produces readable output", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const report = {
      totalTasks: 4,
      pending: 1,
      inProgress: 1,
      completed: 1,
      failed: 1,
      blocked: 1,
      engineers: [
        { id: "eng_a" as EngineerID, state: "working" as const, currentTask: "Auth model" },
        { id: "eng_b" as EngineerID, state: "idle" as const, currentTask: null },
      ],
      blockers: [],
    }

    const status = service.formatStatus(report)
    expect(status).toContain("1/4 completed")
    expect(status).toContain("eng_a [working] — Auth model")
    expect(status).toContain("eng_b [idle]")
  })

  test("monitor returns report with rateLimits populated when RateLimiter has state", async () => {
    const mockStats: RateLimiterStats = {
      activeCalls: 2,
      queuedCalls: 1,
      tokensUsedThisMinute: 12000,
      tokensBudgetPerMinute: 100000,
      circuitBreakerOpen: false,
      consecutive429s: 0,
    }

    const rateLimiterWithStats = makeMemoryRateLimiter(mockStats)
    const layerWithStats = leadLayer.pipe(
      Layer.provide(
        Layer.merge(testTaskBoardLayer, Layer.succeed(RateLimiterService, rateLimiterWithStats)),
      ),
    )

    const report = await Effect.provide(
      Effect.gen(function* () {
        const svc = yield* LeadCoordinatorService
        return yield* svc.monitor(TEAM_ID)
      }),
      layerWithStats,
    ).pipe(Effect.runPromise)

    expect(report.rateLimits).toBeDefined()
    expect(report.rateLimits).not.toBeNull()
    expect(report.rateLimits!.tokensUsedThisMinute).toBe(12000)
    expect(report.rateLimits!.tokensBudgetPerMinute).toBe(100000)
    expect(report.rateLimits!.activeCalls).toBe(2)
    expect(report.rateLimits!.queuedCalls).toBe(1)
    expect(report.rateLimits!.circuitBreakerOpen).toBe(false)
  })

  test("monitor returns rateLimits null when RateLimiter has no state for team", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const report = await runWith(service.monitor("team_no_rl_state" as TeamID))
    expect(report.rateLimits).toBeNull()
  })

  test("formatStatus renders rate-limit summary when rateLimits present", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const report = {
      totalTasks: 2,
      pending: 0,
      inProgress: 1,
      completed: 1,
      failed: 0,
      blocked: 0,
      engineers: [],
      blockers: [],
      rateLimits: {
        activeCalls: 3,
        queuedCalls: 2,
        tokensUsedThisMinute: 12000,
        tokensBudgetPerMinute: 100000,
        circuitBreakerOpen: false,
        consecutive429s: 0,
      } satisfies RateLimiterStats,
    }

    const status = service.formatStatus(report)
    expect(status).toContain("Rate limits:")
    expect(status).toContain("12000/100000")
    expect(status).toContain("12%")
    expect(status).toContain("active 3")
    expect(status).toContain("queued 2")
    expect(status).toContain("CB: closed")
  })

  test("formatStatus renders circuit breaker open with 429 count", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const report = {
      totalTasks: 1,
      pending: 0,
      inProgress: 0,
      completed: 1,
      failed: 0,
      blocked: 0,
      engineers: [],
      blockers: [],
      rateLimits: {
        activeCalls: 0,
        queuedCalls: 5,
        tokensUsedThisMinute: 0,
        tokensBudgetPerMinute: 100000,
        circuitBreakerOpen: true,
        consecutive429s: 3,
      } satisfies RateLimiterStats,
    }

    const status = service.formatStatus(report)
    expect(status).toContain("CB: open")
    expect(status).toContain("3 429s")
  })

  test("formatStatus omits rate-limit line when rateLimits is null/undefined", async () => {
    const service = await runWith(Effect.gen(function* () {
      return yield* LeadCoordinatorService
    }))

    const report = {
      totalTasks: 1,
      pending: 1,
      inProgress: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      engineers: [],
      blockers: [],
    }

    const status = service.formatStatus(report)
    expect(status).not.toContain("Rate limits:")
  })
})
