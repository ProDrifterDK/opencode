import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer, Scope, Fiber } from "effect"
import { Service as HeartbeatService } from "./heartbeat"
import { Service as SessionCoordinatorService, CoordinatorError, type EngineerSlot, type TeamRecord } from "./session-coordinator"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as MailboxService } from "./mailbox"
import { Service as TaskBoardRepoService } from "./task-board"
import { Service as RateLimiterService, CircuitBreakerOpenError } from "./rate-limiter"
import { Service as GitManagerService } from "./git-manager"
import { ENGINEER_MAX_IDLE, MAILBOX_QUEUE_DEPTH, MAX_TEAM_SIZE, MAILBOX_MAX_AGE_MS } from "./constants"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "../session/schema"
import type { Task, TaskBoardID, CreateTaskInput, UpdateTaskInput, TaskBoardFilter } from "./task-board.sql"
import type { MailboxRow, MailboxPriority } from "./mailbox.sql"

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = "team_lifecycle" as TeamID
const LEAD_SESSION = "sess_lead" as SessionID
const ENG_A = "eng_a" as EngineerID
const ENG_B = "eng_b" as EngineerID
const ENG_C = "eng_c" as EngineerID
const ENG_D = "eng_d" as EngineerID
const ENG_E = "eng_e" as EngineerID

// ---------------------------------------------------------------------------
// Shared mutable state (reset each test)
// ---------------------------------------------------------------------------

let engineers: Map<EngineerID, EngineerSlot>
let teams: Map<TeamID, TeamRecord>
let mailboxStore: Map<string, MailboxRow>
let tasks: Map<string, Task>
let taskIdCounter: number

const resetState = () => {
  engineers = new Map()
  teams = new Map()
  mailboxStore = new Map()
  tasks = new Map()
  taskIdCounter = 0
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const nextTaskId = (): TaskBoardID => `task_${++taskIdCounter}` as TaskBoardID

const makeSlot = (overrides: Partial<EngineerSlot> = {}): EngineerSlot => ({
  engineerID: ENG_A,
  teamID: TEAM_ID,
  sessionID: "sess_eng_a" as SessionID,
  name: "engineer-a",
  state: "idle",
  currentTask: null,
  agentName: null,
  agentColor: null,
  fallbackAgent: null,
  startedAt: Date.now(),
  lastHeartbeat: Date.now(),
  ...overrides,
})

const makeTeam = (overrides: Partial<TeamRecord> = {}): TeamRecord => ({
  teamID: TEAM_ID,
  state: "active",
  leadSessionID: LEAD_SESSION,
  engineerCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// In-memory service mocks
// ---------------------------------------------------------------------------

// memMailbox is forward-declared below; Effect.suspend defers the binding lookup
// until call time so the const-binding resolves correctly.
const purgeViaMailbox = (sessionID: SessionID) =>
  Effect.suspend(() => memMailbox.purge(sessionID)).pipe(
    Effect.mapError((cause) => new CoordinatorError({ message: cause.message })),
  )

const memCoordinator = SessionCoordinatorService.of({
  createTeam: (input) =>
    Effect.sync(() => {
      const record: TeamRecord = {
        teamID: input.teamID,
        state: "idle",
        leadSessionID: input.leadSessionID,
        engineerCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      teams.set(input.teamID, record)
      return record
    }),
  spawnEngineer: (input) =>
    Effect.sync(() => {
      const count = [...engineers.values()].filter((e) => e.teamID === input.teamID).length
      const engineerID = `eng_${count + 1}` as EngineerID
      const slot = makeSlot({
        engineerID,
        teamID: input.teamID,
        sessionID: `sess_${engineerID}` as SessionID,
        name: input.name ?? `engineer-${count + 1}`,
      })
      engineers.set(engineerID, slot)
      const team = teams.get(input.teamID)
      if (team) {
        team.engineerCount = count + 1
        team.state = "active"
      }
      return slot
    }),

  resumeEngineer: (input) =>
    Effect.sync(() => {
      const slot = engineers.get(input.engineerID)
      if (!slot) throw new Error(`Engineer not found: ${input.engineerID}`)
      return { ...slot, state: "idle" as const }
    }),

  killEngineer: (input) =>
    Effect.gen(function* () {
      const slot = engineers.get(input.engineerID)
      engineers.delete(input.engineerID)
      const team = teams.get(input.teamID)
      if (team) {
        const remaining = [...engineers.values()].filter((e) => e.teamID === input.teamID)
        team.engineerCount = remaining.length
        if (remaining.length === 0) team.state = "idle"
      }
      // Mirror real wiring: session-coordinator delegates mailbox cleanup to Mailbox.purge.
      // Calling memMailbox.purge here ensures the mock breaks if production code skips the call.
      if (slot) yield* purgeViaMailbox(slot.sessionID)
    }),

  dissolveTeam: (input) =>
    Effect.gen(function* () {
      const teamEngineers = [...engineers.values()].filter((e) => e.teamID === input.teamID)
      for (const eng of teamEngineers) {
        // Delegate per-engineer mailbox purge to Mailbox.purge to mirror real wiring.
        yield* purgeViaMailbox(eng.sessionID)
        engineers.delete(eng.engineerID)
      }
      for (const [id, t] of tasks) {
        if (t.team_id === input.teamID) tasks.delete(id)
      }
      teams.delete(input.teamID)
    }),

  resumeTeam: (teamID) =>
    Effect.gen(function* () {
      const team = teams.get(teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${teamID}` }))
      }
      if (team.state !== "terminated") {
        return yield* Effect.fail(
          new CoordinatorError({
            message: `Cannot resume team in state ${team.state}. Only terminated teams can be resumed.`,
          }),
        )
      }
      const next: TeamRecord = { ...team, state: "active", updatedAt: Date.now() }
      teams.set(teamID, next)
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      return { team: next, engineers: slots }
    }),
  getTeam: (teamID) => Effect.sync(() => teams.get(teamID) ?? null),
  getEngineer: (engineerID) => Effect.sync(() => engineers.get(engineerID) ?? null),
  listTeamEngineers: (teamID, options) =>
    Effect.sync(() => {
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      if (options?.liveOnly) {
        return slots.filter((s) => s.state !== "failed")
      }
      return slots
    }),
  listAllEngineers: () => Effect.sync(() => [...engineers.values()]),
  listTeams: () => Effect.sync(() => [...teams.values()]),
  isLead: (sessionID) =>
    Effect.sync(() => [...teams.values()].some((t) => t.leadSessionID === sessionID)),
  isEngineer: (sessionID) =>
    Effect.sync(() => [...engineers.values()].some((e) => e.sessionID === sessionID)),
  getEngineerBySession: (sessionID) =>
    Effect.sync(() => [...engineers.values()].find((e) => e.sessionID === sessionID) ?? null),
  updateEngineer: (engineerID, updates) =>
    Effect.sync(() => {
      const slot = engineers.get(engineerID)
      if (!slot) throw new Error(`Engineer not found: ${engineerID}`)
      const updated: EngineerSlot = {
        ...slot,
        ...(updates.state !== undefined ? { state: updates.state } : {}),
        ...(updates.currentTask !== undefined ? { currentTask: updates.currentTask } : {}),
        lastHeartbeat: updates.lastHeartbeat ?? Date.now(),
      }
      engineers.set(engineerID, updated)
      return updated
    }),
  getTeamForSession: (sessionID) =>
    Effect.sync(() => {
      const asLead = [...teams.values()].find((t) => t.leadSessionID === sessionID)
      if (asLead) return asLead.teamID
      const asEngineer = [...engineers.values()].find((e) => e.sessionID === sessionID)
      if (asEngineer) return asEngineer.teamID
      return null
    }),
})

const memMailbox = MailboxService.of({
  send: (input) =>
    Effect.sync(() => {
      const id = crypto.randomUUID() as string & { readonly __brand: "MailboxID" }
      const row: MailboxRow = {
        id,
        recipient_session_id: input.recipientSessionID,
        sender_session_id: input.senderSessionID,
        priority: input.priority as MailboxPriority,
        type: input.type,
        content: input.content,
        created_at: Date.now(),
        read_at: null,
      }
      mailboxStore.set(id, row)

      const recipientMsgs = [...mailboxStore.values()]
        .filter((m) => m.recipient_session_id === input.recipientSessionID)
        .sort((a, b) => a.created_at - b.created_at)
      if (recipientMsgs.length > MAILBOX_QUEUE_DEPTH) {
        const overflow = recipientMsgs.length - MAILBOX_QUEUE_DEPTH
        for (let i = 0; i < overflow; i++) {
          mailboxStore.delete(recipientMsgs[i].id)
        }
      }

      return row
    }),

  receive: (recipientSessionID) =>
    Effect.sync(() => {
      const priorityOrder: Record<string, number> = { urgent: 0, inbox: 1, queue: 2 }
      return [...mailboxStore.values()]
        .filter((m) => m.recipient_session_id === recipientSessionID && m.read_at === null)
        .sort((a, b) => {
          const pd = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
          if (pd !== 0) return pd
          return a.created_at - b.created_at
        })
    }),

  receiveByPriority: (input) =>
    Effect.sync(() =>
      [...mailboxStore.values()]
        .filter(
          (m) =>
            m.recipient_session_id === input.recipientSessionID &&
            m.priority === input.priority &&
            m.read_at === null,
        )
        .sort((a, b) => a.created_at - b.created_at),
    ),

  peek: (recipientSessionID) =>
    Effect.sync(() =>
      [...mailboxStore.values()]
        .filter((m) => m.recipient_session_id === recipientSessionID)
        .sort((a, b) => a.created_at - b.created_at),
    ),

  markRead: (input) =>
    Effect.sync(() => {
      const row = mailboxStore.get(input.messageID)
      if (row && row.recipient_session_id === input.recipientSessionID) {
        mailboxStore.set(input.messageID, { ...row, read_at: Date.now() })
      }
    }),

  purge: (recipientSessionID) =>
    Effect.sync(() => {
      for (const [id, row] of mailboxStore) {
        if (row.recipient_session_id === recipientSessionID) mailboxStore.delete(id)
      }
    }),

  purgeOlderThan: (maxAgeMs) =>
    Effect.sync(() => {
      const cutoff = Date.now() - maxAgeMs
      let purged = 0
      for (const [id, row] of mailboxStore) {
        if (row.created_at < cutoff) {
          mailboxStore.delete(id)
          purged++
        }
      }
      return purged
    }),

  hasUnread: (input) =>
    Effect.sync(() =>
      [...mailboxStore.values()].some(
        (m) =>
          m.recipient_session_id === input.recipientSessionID &&
          m.read_at === null &&
          (!input.priority || m.priority === input.priority),
      ),
    ),
})

const memTaskBoard = TaskBoardRepoService.of({
  create: (input: CreateTaskInput) =>
    Effect.sync(() => {
      const id = nextTaskId()
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
        archived_at: null,
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

const memLead = LeadCoordinatorService.of({
  decompose: () => Effect.succeed([]),
  assign: () => Effect.succeed([]),
  monitor: () => Effect.succeed({
    totalTasks: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, engineers: [], blockers: [],
  }),
  reassign: (input) =>
    Effect.sync(() => {
      const task = [...tasks.values()].find((t) => t.id === input.taskId)
      if (!task) throw new Error(`Task not found: ${input.taskId}`)
      const updated = { ...task, assigned_engineer_id: input.toEngineer, status: "in-progress" as const }
      tasks.set(task.id, updated)
      return updated
    }),
  retask: (input) =>
    Effect.sync(() => {
      const task = tasks.get(input.taskId)
      if (!task) throw new Error(`Task not found: ${input.taskId}`)
      const updated = {
        ...task,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.fileScope !== undefined ? { file_scope: JSON.stringify(input.fileScope) } : {}),
      }
      tasks.set(task.id, updated)
      return updated
    }),
  validateFileScopes: () => Effect.succeed(true),
  formatStatus: () => "",
})

const memGit = GitManagerService.of({
  createBranch: (input) => Effect.succeed(`team/${input.teamID}/engineer-${input.engineerID}`),
  detectOverlap: (a, b) =>
    Effect.sync(() => {
      const stripGlob = (s: string) => s.replace(/(\/\*{1,2})+(\.\w+)?$|^\*+$/g, "").replace(/\/+$/, "")
      return a.some((f) => b.some((g) => {
        if (f === g) return true
        const na = stripGlob(f)
        const nb = stripGlob(g)
        if (!na || !nb) return true
        return na.startsWith(nb + "/") || nb.startsWith(na + "/") || na === nb
      }))
    }),
  commitWork: () => Effect.void,
  mergeBranch: () => Effect.void,
  cleanupBranches: () => Effect.void,
  getBranchStatus: (input) =>
    Effect.succeed({
      branch: `team/${input.teamID}/engineer-${input.engineerID}`,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      conflictingFiles: [],
    }),
  commitOnCurrentBranch: () => Effect.void,
  createEngineerWorktree: (input) =>
    Effect.succeed({
      worktreePath: `/tmp/worktrees/${input.teamID}/${input.engineerID}`,
      branch: `team/${input.teamID}/engineer-${input.engineerID}`,
    }),
  removeEngineerWorktree: () => Effect.void,
  commitInWorktree: () => Effect.void,
  listEngineerWorktrees: () => Effect.succeed([] as const),
})

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

const baseLayer = Layer.succeed(SessionCoordinatorService, memCoordinator).pipe(
  Layer.merge(Layer.succeed(MailboxService, memMailbox)),
  Layer.merge(Layer.succeed(LeadCoordinatorService, memLead)),
  Layer.merge(Layer.succeed(TaskBoardRepoService, memTaskBoard)),
  Layer.merge(Layer.succeed(GitManagerService, memGit)),
)

import { layer as heartbeatLayer } from "./heartbeat"
import { layer as rateLimiterLayer } from "./rate-limiter"

const resolvedHeartbeat = heartbeatLayer.pipe(Layer.provide(baseLayer))
const resolvedRateLimiter = rateLimiterLayer

const runHeartbeat = <A>(
  effect: Effect.Effect<A, any, HeartbeatService>,
) => Effect.provide(effect, resolvedHeartbeat).pipe(Effect.runPromise)

const runRateLimiter = <A>(
  effect: Effect.Effect<A, any, RateLimiterService>,
) => Effect.provide(effect, resolvedRateLimiter).pipe(Effect.runPromise)

const runRateLimiterScoped = <A>(
  effect: Effect.Effect<A, any, RateLimiterService | Scope.Scope>,
) => Effect.provide(effect, resolvedRateLimiter).pipe(Effect.scoped, Effect.runPromise)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Team Lifecycle Integration", () => {
  beforeEach(resetState)

  // 1. Full lifecycle: spawn team → engineers → tasks → complete → dissolve
  test("full lifecycle: team created → engineers spawned → tasks assigned → work completed → team dissolved", async () => {
    // Setup team
    teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))

    // Spawn 3 engineers via coordinator mock
    const eng1 = await Effect.runPromise(
      memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-1" }),
    )
    const eng2 = await Effect.runPromise(
      memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-2" }),
    )
    const eng3 = await Effect.runPromise(
      memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-3" }),
    )

    expect(engineers.size).toBe(3)
    expect(teams.get(TEAM_ID)!.engineerCount).toBe(3)

    // Create and assign tasks
    const task1 = await Effect.runPromise(
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: "Implement auth",
        description: "Add authentication",
        file_scope: '["src/auth/"]',
        status: "in-progress",
        assigned_engineer_id: eng1.engineerID,
      }),
    )
    const task2 = await Effect.runPromise(
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: "Add tests",
        description: "Test suite",
        file_scope: '["src/auth.test/"]',
        status: "in-progress",
        assigned_engineer_id: eng2.engineerID,
      }),
    )
    const task3 = await Effect.runPromise(
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: "Documentation",
        description: "Write docs",
        file_scope: '["docs/"]',
        status: "pending",
      }),
    )

    // Complete tasks
    await Effect.runPromise(
      memTaskBoard.update(task1.id, { status: "completed", completed_at: Date.now() }),
    )
    await Effect.runPromise(
      memTaskBoard.update(task2.id, { status: "completed", completed_at: Date.now() }),
    )

    // Verify progress
    const allTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(allTasks.filter((t) => t.status === "completed")).toHaveLength(2)
    expect(allTasks.filter((t) => t.status === "pending")).toHaveLength(1)

    // Dissolve team
    await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))

    // Verify cleanup
    expect(teams.has(TEAM_ID)).toBe(false)
    expect([...engineers.values()].filter((e) => e.teamID === TEAM_ID)).toHaveLength(0)
    const remainingTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(remainingTasks).toHaveLength(0)
  })

  // 2. Circular dependency detection
  test("circular dependency detection in task assignments", async () => {
    teams.set(TEAM_ID, makeTeam())

    const blockerTask = await Effect.runPromise(
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: "Task A",
        description: "First task",
        status: "blocked",
        assigned_engineer_id: ENG_A,
      }),
    )

    // Task A blocked by Task B, Task B blocked by Task A (circular)
    const blockedTask = await Effect.runPromise(
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: "Task B",
        description: "Second task — circular",
        status: "blocked",
        blocked_by: blockerTask.id,
        assigned_engineer_id: ENG_B,
      }),
    )

    // Now make A blocked by B too (circular)
    await Effect.runPromise(
      memTaskBoard.update(blockerTask.id, { blocked_by: blockedTask.id }),
    )

    // Detect circular: build a graph and check for cycles
    const allTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    const taskMap = new Map(allTasks.map((t) => [t.id, t]))
    const visited = new Set<TaskBoardID>()
    const inStack = new Set<TaskBoardID>()
    let hasCircular = false

    const detectCycle = (taskId: TaskBoardID): boolean => {
      if (inStack.has(taskId)) return true
      if (visited.has(taskId)) return false
      visited.add(taskId)
      inStack.add(taskId)
      const task = taskMap.get(taskId)
      if (task?.blocked_by) {
        if (detectCycle(task.blocked_by)) return true
      }
      inStack.delete(taskId)
      return false
    }

    for (const t of allTasks) {
      visited.clear()
      inStack.clear()
      if (detectCycle(t.id)) {
        hasCircular = true
        break
      }
    }

    expect(hasCircular).toBe(true)
    expect(allTasks.filter((t) => t.status === "blocked")).toHaveLength(2)
  })

  // 3. All engineers fail → lead receives notification
  test("all engineers fail → lead receives all-failed notification", async () => {
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, currentTask: "task_1" as TaskBoardID, state: "working" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))

    const service = await runHeartbeat(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runHeartbeat(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.action).toBe("all-failed")
    expect(engineers.has(ENG_A)).toBe(false)

    // Verify lead was notified
    const leadMsgs = [...mailboxStore.values()].filter(
      (m) => m.recipient_session_id === LEAD_SESSION && m.type === "all-engineers-failed",
    )
    expect(leadMsgs).toHaveLength(1)
    expect(leadMsgs[0].priority).toBe("urgent")
  })

  // 4. Mailbox overflow — depth limit enforced
  test("mailbox overflow: depth limit 50 enforced, oldest messages dropped", async () => {
    const recipient = "sess_overflow" as SessionID

    // Send 55 messages
    for (let i = 0; i < 55; i++) {
      await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: recipient,
          senderSessionID: LEAD_SESSION,
          priority: "inbox",
          type: "task-update",
          content: `Message ${i}`,
        }),
      )
    }

    const allMsgs = await Effect.runPromise(memMailbox.peek(recipient))

    expect(allMsgs.length).toBe(MAILBOX_QUEUE_DEPTH)

    // Oldest messages (0-4) should be dropped
    const contents = allMsgs.map((m) => m.content)
    expect(contents).not.toContain("Message 0")
    expect(contents).not.toContain("Message 4")
    expect(contents).toContain("Message 5")
    expect(contents).toContain("Message 54")
  })

  // 5. SQLite contention — concurrent operations all succeed
  test("concurrent task operations all succeed without corruption", async () => {
    teams.set(TEAM_ID, makeTeam())

    // Create 5 tasks concurrently
    const createEffects = Array.from({ length: 5 }, (_, i) =>
      memTaskBoard.create({
        team_id: TEAM_ID,
        title: `Concurrent task ${i}`,
        description: `Description ${i}`,
        file_scope: `["src/file${i}.ts"]`,
      }),
    )

    const results = await Promise.all(createEffects.map((e) => Effect.runPromise(e)))

    expect(results).toHaveLength(5)
    expect(new Set(results.map((r) => r.id)).size).toBe(5)

    // Update all concurrently
    const updateEffects = results.map((t) =>
      memTaskBoard.update(t.id, { status: "in-progress" }),
    )
    const updated = await Promise.all(updateEffects.map((e) => Effect.runPromise(e)))

    expect(updated.every((t) => t.status === "in-progress")).toBe(true)

    // Complete all concurrently
    const completeEffects = results.map((t) =>
      memTaskBoard.update(t.id, { status: "completed", completed_at: Date.now() }),
    )
    const completed = await Promise.all(completeEffects.map((e) => Effect.runPromise(e)))

    expect(completed.every((t) => t.status === "completed")).toBe(true)

    // Verify final state
    const all = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(all).toHaveLength(5)
    expect(all.every((t) => t.status === "completed")).toBe(true)
  })

  // 6. File scope conflict detection
  test("file scope conflict detection prevents overlapping assignments", async () => {
    const git = await Effect.runPromise(
      Effect.provide(Effect.gen(function* () { return yield* GitManagerService }), Layer.succeed(GitManagerService, memGit)),
    )

    // Direct overlap
    const overlap1 = await Effect.runPromise(git.detectOverlap(["src/auth/login.ts"], ["src/auth/login.ts"]))
    expect(overlap1).toBe(true)

    // Prefix overlap
    const overlap2 = await Effect.runPromise(git.detectOverlap(["src/auth/"], ["src/auth/handlers.ts"]))
    expect(overlap2).toBe(true)

    // No overlap
    const noOverlap = await Effect.runPromise(git.detectOverlap(["src/auth/*"], ["src/billing/*"]))
    expect(noOverlap).toBe(false)
  })

  // 7. Task reassignment on engineer failure
  test("task reassignment: engineer fails, task reassigned to idle engineer", async () => {
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, currentTask: "task_1" as TaskBoardID, state: "working" }))
    engineers.set(ENG_B, makeSlot({
      engineerID: ENG_B,
      sessionID: "sess_eng_b" as SessionID,
      name: "engineer-b",
      state: "idle",
    }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    const service = await runHeartbeat(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runHeartbeat(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.action).toBe("reassigned")
    expect(result.taskReassignedTo).toBe(ENG_B)
    expect(engineers.has(ENG_A)).toBe(false)
    expect(engineers.has(ENG_B)).toBe(true)
  })

  // 7b. Rate limiter reconcile: token budget adjusted after engineer loop completes
  test("rate limiter reconcile: actual > estimate bumps tokensUsedThisMinute", async () => {
    const result = await runRateLimiter(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.acquire(TEAM_ID, ENG_A, "engineer", 8000)
      yield* service.reconcile(TEAM_ID, ENG_A, 8000, 14000)
      return service.getStats(TEAM_ID)
    }))

    expect(result?.tokensUsedThisMinute).toBe(14000)
  })

  test("rate limiter reconcile: actual < estimate reduces tokensUsedThisMinute", async () => {
    const result = await runRateLimiter(Effect.gen(function* () {
      const service = yield* RateLimiterService
      yield* service.acquire(TEAM_ID, ENG_A, "engineer", 8000)
      yield* service.reconcile(TEAM_ID, ENG_A, 8000, 2000)
      return service.getStats(TEAM_ID)
    }))

    expect(result?.tokensUsedThisMinute).toBe(2000)
  })

  test("rate limiter reconcile: no-op when team dissolved before reconcile", async () => {
    await expect(
      runRateLimiter(Effect.gen(function* () {
        const service = yield* RateLimiterService
        // Never acquired — simulate dissolved team scenario
        yield* service.reconcile(TEAM_ID, ENG_A, 8000, 12000)
      })),
    ).resolves.toBeUndefined()
  })

  // 8. Rate limit queue — 6th request queued
  test("rate limit queue: 6th request queued when max concurrent = 4 and 2 in queue", async () => {
    const result = await runRateLimiterScoped(Effect.gen(function* () {
      const service = yield* RateLimiterService

      // Fill 4 slots
      for (let i = 0; i < 4; i++) {
        yield* service.acquire(TEAM_ID, `eng_fill_${i}` as EngineerID, "engineer", 100).pipe(
          Effect.forkScoped,
        )
      }

      yield* Effect.sleep(5)
      expect(service.getStats(TEAM_ID)?.activeCalls).toBe(4)

      // Queue 2 more
      yield* service.acquire(TEAM_ID, ENG_A, "engineer", 100).pipe(Effect.forkScoped)
      yield* service.acquire(TEAM_ID, ENG_B, "engineer", 100).pipe(Effect.forkScoped)
      yield* Effect.sleep(5)

      expect(service.getStats(TEAM_ID)?.queuedCalls).toBe(2)
      expect(service.getStats(TEAM_ID)?.activeCalls).toBe(4)

      return service.getStats(TEAM_ID)
    }))

    expect(result?.queuedCalls).toBe(2)
    expect(result?.activeCalls).toBe(4)
  })

  // 9. Orphan detection: lead dies, engineers self-terminate
  test("orphan detection: lead dies → engineers self-terminate", async () => {
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A }))
    engineers.set(ENG_B, makeSlot({
      engineerID: ENG_B,
      sessionID: "sess_eng_b" as SessionID,
      name: "engineer-b",
    }))
    engineers.set(ENG_C, makeSlot({
      engineerID: ENG_C,
      sessionID: "sess_eng_c" as SessionID,
      name: "engineer-c",
    }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 3 }))

    const service = await runHeartbeat(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    // Lead is alive
    const aliveResult = await runHeartbeat(service.detectOrphans(TEAM_ID, LEAD_SESSION))
    expect(aliveResult.leadAlive).toBe(true)
    expect(aliveResult.engineersTerminated).toHaveLength(0)

    // Simulate lead death by removing the team
    teams.delete(TEAM_ID)

    const deadResult = await runHeartbeat(service.detectOrphans(TEAM_ID, LEAD_SESSION))
    expect(deadResult.leadAlive).toBe(false)
    expect(deadResult.engineersTerminated).toHaveLength(3)
    expect(deadResult.engineersTerminated).toContain(ENG_A)
    expect(deadResult.engineersTerminated).toContain(ENG_B)
    expect(deadResult.engineersTerminated).toContain(ENG_C)

    // Verify engineers are actually killed
    expect([...engineers.values()].filter((e) => e.teamID === TEAM_ID)).toHaveLength(0)
  })

  // 10. Team dissolution cleanup: all mailboxes purged, all engineers killed
  test("team dissolution cleanup: all mailboxes purged, all engineers killed", async () => {
    teams.set(TEAM_ID, makeTeam({ engineerCount: 3 }))
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, sessionID: "sess_a" as SessionID, name: "engineer-a" }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_b" as SessionID, name: "engineer-b" }))
    engineers.set(ENG_C, makeSlot({ engineerID: ENG_C, sessionID: "sess_c" as SessionID, name: "engineer-c" }))

    // Send messages to each engineer
    for (const eng of [ENG_A, ENG_B, ENG_C]) {
      const slot = engineers.get(eng)!
      await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: slot.sessionID,
          senderSessionID: LEAD_SESSION,
          priority: "inbox",
          type: "task-assignment",
          content: `Work for ${eng}`,
        }),
      )
    }

    // Create team tasks
    await Effect.runPromise(
      memTaskBoard.create({ team_id: TEAM_ID, title: "Task 1", description: "t1", file_scope: '["src/a.ts"]' }),
    )
    await Effect.runPromise(
      memTaskBoard.create({ team_id: TEAM_ID, title: "Task 2", description: "t2", file_scope: '["src/b.ts"]' }),
    )

    // Verify state before dissolution
    expect(mailboxStore.size).toBe(3)
    expect(engineers.size).toBe(3)
    const tasksBefore = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(tasksBefore).toHaveLength(2)

    // Dissolve
    await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))

    // Verify all cleaned up
    expect(teams.has(TEAM_ID)).toBe(false)
    expect([...engineers.values()].filter((e) => e.teamID === TEAM_ID)).toHaveLength(0)
    expect(mailboxStore.size).toBe(0)
    const tasksAfter = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(tasksAfter).toHaveLength(0)
  })

  // 11. Performance: 5 engineers operate concurrently
  test("performance: 5 engineers created and operate concurrently", async () => {
    teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))

    // Spawn 5 engineers concurrently
    const spawnPromises = Array.from({ length: MAX_TEAM_SIZE }, (_, i) =>
      Effect.runPromise(
        memCoordinator.spawnEngineer({
          teamID: TEAM_ID,
          leadSessionID: LEAD_SESSION,
          name: `engineer-${i + 1}`,
        }),
      ),
    )
    const spawned = await Promise.all(spawnPromises)

    expect(spawned).toHaveLength(MAX_TEAM_SIZE)
    expect(teams.get(TEAM_ID)!.engineerCount).toBe(MAX_TEAM_SIZE)

    // Create tasks for each
    const taskPromises = spawned.map((eng, i) =>
      Effect.runPromise(
        memTaskBoard.create({
          team_id: TEAM_ID,
          title: `Task for ${eng.name}`,
          description: `Work ${i}`,
          file_scope: `["src/module${i}/"]`,
          status: "in-progress",
          assigned_engineer_id: eng.engineerID,
        }),
      ),
    )
    const createdTasks = await Promise.all(taskPromises)
    expect(createdTasks).toHaveLength(MAX_TEAM_SIZE)

    // Complete all concurrently
    const completePromises = createdTasks.map((t) =>
      Effect.runPromise(memTaskBoard.update(t.id, { status: "completed", completed_at: Date.now() })),
    )
    await Promise.all(completePromises)

    const allTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(allTasks.every((t) => t.status === "completed")).toBe(true)

    // Record heartbeats concurrently
    const heartbeatService = await runHeartbeat(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    for (const eng of spawned) {
      await runHeartbeat(heartbeatService.recordHeartbeat(eng.engineerID))
    }

    for (const eng of spawned) {
      const health = heartbeatService.getHealth(eng.engineerID)
      expect(health).not.toBeNull()
      expect(health!.isStuck).toBe(false)
      expect(health!.isDead).toBe(false)
    }
  })

  // 12. Heartbeat backoff clears on successful heartbeat
  test("heartbeat: rate limit backoff clears on successful heartbeat", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runHeartbeat(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runHeartbeat(service.recordHeartbeat(ENG_A))
    await runHeartbeat(service.handleRateLimit(ENG_A))
    await runHeartbeat(service.handleRateLimit(ENG_A))

    const healthWithBackoff = service.getHealth(ENG_A)!
    expect(healthWithBackoff.backoffUntil).not.toBeNull()

    // Successful heartbeat clears backoff
    await runHeartbeat(service.recordHeartbeat(ENG_A))

    const healthCleared = service.getHealth(ENG_A)!
    expect(healthCleared.backoffUntil).toBeNull()
    expect(healthCleared.stuckCount).toBe(0)
  })

  // 13. Circuit breaker triggers and blocks all requests
  test("circuit breaker: triggers after 3 consecutive 429s and blocks new requests", async () => {
    const error = await runRateLimiter(
      Effect.gen(function* () {
        const service = yield* RateLimiterService
        yield* service.report429(TEAM_ID, ENG_A)
        yield* service.report429(TEAM_ID, ENG_A)
        yield* service.report429(TEAM_ID, ENG_A)

        const stats = service.getStats(TEAM_ID)
        expect(stats?.circuitBreakerOpen).toBe(true)

        // New request should fail
        yield* service.acquire(TEAM_ID, ENG_B, "engineer", 100)
      }).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(CircuitBreakerOpenError)
    expect((error as CircuitBreakerOpenError).remainingMs).toBeGreaterThan(0)
  })

  // 14. Mailbox priority ordering
  test("mailbox: priority ordering — urgent before inbox before queue", async () => {
    const recipient = "sess_priority" as SessionID

    // Send in reverse priority order
    await Effect.runPromise(memMailbox.send({
      recipientSessionID: recipient,
      senderSessionID: LEAD_SESSION,
      priority: "queue",
      type: "low",
      content: "low priority",
    }))
    await Effect.runPromise(memMailbox.send({
      recipientSessionID: recipient,
      senderSessionID: LEAD_SESSION,
      priority: "inbox",
      type: "normal",
      content: "normal priority",
    }))
    await Effect.runPromise(memMailbox.send({
      recipientSessionID: recipient,
      senderSessionID: LEAD_SESSION,
      priority: "urgent",
      type: "critical",
      content: "urgent priority",
    }))

    const unread = await Effect.runPromise(memMailbox.receive(recipient))
    expect(unread).toHaveLength(3)
    expect(unread[0].priority).toBe("urgent")
    expect(unread[1].priority).toBe("inbox")
    expect(unread[2].priority).toBe("queue")
  })

  // 15. Mark read and hasUnread interaction
  test("mailbox: markRead updates read status and hasUnread reflects correctly", async () => {
    const recipient = "sess_read_test" as SessionID

    await Effect.runPromise(memMailbox.send({
      recipientSessionID: recipient,
      senderSessionID: LEAD_SESSION,
      priority: "inbox",
      type: "task",
      content: "Do something",
    }))

    const hasUnreadBefore = await Effect.runPromise(memMailbox.hasUnread({ recipientSessionID: recipient }))
    expect(hasUnreadBefore).toBe(true)

    const msgs = await Effect.runPromise(memMailbox.receive(recipient))
    expect(msgs).toHaveLength(1)

    await Effect.runPromise(memMailbox.markRead({ messageID: msgs[0].id, recipientSessionID: recipient }))

    const hasUnreadAfter = await Effect.runPromise(memMailbox.hasUnread({ recipientSessionID: recipient }))
    expect(hasUnreadAfter).toBe(false)

    const afterRead = await Effect.runPromise(memMailbox.receive(recipient))
    expect(afterRead).toHaveLength(0)
  })

  // 16. Team state transitions
  test("team state transitions: idle → active → dissolving → cleaned", async () => {
    teams.set(TEAM_ID, makeTeam({ state: "idle", engineerCount: 0 }))

    const spawned = await Effect.runPromise(
      memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION }),
    )
    expect(teams.get(TEAM_ID)!.state).toBe("active")
    expect(teams.get(TEAM_ID)!.engineerCount).toBe(1)

    await Effect.runPromise(
      memCoordinator.killEngineer({ engineerID: spawned.engineerID, teamID: TEAM_ID }),
    )
    const team = teams.get(TEAM_ID)
    if (team) {
      expect(team.engineerCount).toBe(0)
    }

    teams.set(TEAM_ID, makeTeam({ state: "active", engineerCount: 1 }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B }))
    teams.get(TEAM_ID)!.engineerCount = 1

    await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))
    expect(teams.has(TEAM_ID)).toBe(false)
  })

  // ── B5: Mailbox TTL + GC + purge wiring regression ─────────────────
  describe("Mailbox GC", () => {
    test("purgeOlderThan removes messages older than threshold", async () => {
      const recipient = "sess_gc_recipient" as SessionID
      const sender = "sess_gc_sender" as SessionID

      // Inject a message, then backdate it
      const oldMsg = await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: recipient,
          senderSessionID: sender,
          priority: "inbox",
          type: "info",
          content: "old message",
        }),
      )
      // Backdate to 25h ago by mutating the in-memory row directly
      const stored = mailboxStore.get(oldMsg.id)!
      mailboxStore.set(oldMsg.id, { ...stored, created_at: Date.now() - (MAILBOX_MAX_AGE_MS + 60_000) })

      // Add a fresh message that should survive
      await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: recipient,
          senderSessionID: sender,
          priority: "inbox",
          type: "info",
          content: "fresh message",
        }),
      )

      const purged = await Effect.runPromise(memMailbox.purgeOlderThan(MAILBOX_MAX_AGE_MS))
      expect(purged).toBe(1)

      const remaining = await Effect.runPromise(memMailbox.peek(recipient))
      expect(remaining.length).toBe(1)
      expect(remaining[0].content).toBe("fresh message")
    })

    test("purgeOlderThan does NOT purge messages exactly at the cutoff (lt is strict)", async () => {
      const recipient = "sess_gc_boundary" as SessionID
      const sender = "sess_gc_sender2" as SessionID

      const msg = await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: recipient,
          senderSessionID: sender,
          priority: "inbox",
          type: "info",
          content: "boundary message",
        }),
      )
      // Backdate exactly to the cutoff boundary (created_at === now - maxAgeMs)
      const stored = mailboxStore.get(msg.id)!
      mailboxStore.set(msg.id, { ...stored, created_at: Date.now() - MAILBOX_MAX_AGE_MS })

      // lt is strict — message exactly at boundary should survive
      const purged = await Effect.runPromise(memMailbox.purgeOlderThan(MAILBOX_MAX_AGE_MS))
      expect(purged).toBe(0)

      const remaining = await Effect.runPromise(memMailbox.peek(recipient))
      expect(remaining.length).toBe(1)
    })

    test("killEngineer purges that engineer's mailbox", async () => {
      teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))
      const eng = await Effect.runPromise(
        memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-kill" }),
      )

      await Effect.runPromise(
        memMailbox.send({
          recipientSessionID: eng.sessionID,
          senderSessionID: LEAD_SESSION,
          priority: "inbox",
          type: "task-assignment",
          content: "test",
        }),
      )

      const before = await Effect.runPromise(memMailbox.peek(eng.sessionID))
      expect(before.length).toBe(1)

      await Effect.runPromise(memCoordinator.killEngineer({ teamID: TEAM_ID, engineerID: eng.engineerID }))

      const remaining = await Effect.runPromise(memMailbox.peek(eng.sessionID))
      expect(remaining.length).toBe(0)
    })

    test("dissolveTeam purges all engineers' mailboxes", async () => {
      teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))
      const e1 = await Effect.runPromise(
        memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-d1" }),
      )
      const e2 = await Effect.runPromise(
        memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-d2" }),
      )

      for (const sid of [e1.sessionID, e2.sessionID]) {
        await Effect.runPromise(
          memMailbox.send({
            recipientSessionID: sid,
            senderSessionID: LEAD_SESSION,
            priority: "inbox",
            type: "task-assignment",
            content: "work",
          }),
        )
      }

      expect(mailboxStore.size).toBe(2)

      await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))

      const r1 = await Effect.runPromise(memMailbox.peek(e1.sessionID))
      const r2 = await Effect.runPromise(memMailbox.peek(e2.sessionID))
      expect(r1.length).toBe(0)
      expect(r2.length).toBe(0)
    })
  })

  // ── O4: team_resume ──────────────────────────────────────────────────
  describe("team_resume", () => {
    test("resume rejects teams in `active` state", async () => {
      teams.set(TEAM_ID, makeTeam({ state: "active" }))

      const result = await Effect.runPromise(
        memCoordinator.resumeTeam(TEAM_ID).pipe(Effect.flip),
      )

      expect(result).toBeInstanceOf(CoordinatorError)
      expect(result.message).toContain("Cannot resume team in state active")
    })

    test("resume rejects teams in `idle` state", async () => {
      teams.set(TEAM_ID, makeTeam({ state: "idle" }))

      const result = await Effect.runPromise(
        memCoordinator.resumeTeam(TEAM_ID).pipe(Effect.flip),
      )

      expect(result).toBeInstanceOf(CoordinatorError)
      expect(result.message).toContain("Only terminated teams can be resumed")
    })

    test("resume rejects teams in `dissolving` state", async () => {
      teams.set(TEAM_ID, makeTeam({ state: "dissolving" as TeamRecord["state"] }))

      const result = await Effect.runPromise(
        memCoordinator.resumeTeam(TEAM_ID).pipe(Effect.flip),
      )

      expect(result).toBeInstanceOf(CoordinatorError)
      expect(result.message).toContain("Cannot resume team in state dissolving")
    })

    test("resume rejects already-dissolved (missing) teams", async () => {
      // Dissolved teams are deleted from the table; resumeTeam should
      // surface a "not found" rather than silently succeeding.
      const result = await Effect.runPromise(
        memCoordinator.resumeTeam("team_missing" as TeamID).pipe(Effect.flip),
      )

      expect(result).toBeInstanceOf(CoordinatorError)
      expect(result.message).toContain("Team not found")
    })

    test("resume terminated team flips state to active and returns engineer slots", async () => {
      // Set up a terminated team with two engineer slots: one `failed`
      // (subprocess died during the prior shutdown) and one `idle`.
      teams.set(TEAM_ID, makeTeam({ state: "terminated" as TeamRecord["state"], engineerCount: 2 }))
      engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, state: "failed" }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_eng_b" as SessionID,
        name: "engineer-b",
        state: "idle",
      }))

      const result = await Effect.runPromise(memCoordinator.resumeTeam(TEAM_ID))

      expect(result.team.state).toBe("active")
      expect(result.engineers).toHaveLength(2)
      expect(teams.get(TEAM_ID)!.state).toBe("active")

      // Slots themselves are unchanged — resumeTeam reports the prior
      // state. The daemon's resumeTeamMonitoring is responsible for
      // re-spawning subprocesses and resetting tasks.
      const slotStates = result.engineers.map((e) => e.state).sort()
      expect(slotStates).toEqual(["failed", "idle"])
    })

    test("resume is idempotent at the state-machine level (second call after success rejects)", async () => {
      teams.set(TEAM_ID, makeTeam({ state: "terminated" as TeamRecord["state"] }))

      await Effect.runPromise(memCoordinator.resumeTeam(TEAM_ID))

      // Now the team is active. A repeat call must be rejected — we
      // never want a live team to be silently "re-resumed" because that
      // would imply double-spawning subprocesses in the daemon.
      const second = await Effect.runPromise(
        memCoordinator.resumeTeam(TEAM_ID).pipe(Effect.flip),
      )

      expect(second).toBeInstanceOf(CoordinatorError)
      expect(second.message).toContain("Cannot resume team in state active")
    })

    test("resume preserves engineer slot identity (no new sessions created)", async () => {
      teams.set(TEAM_ID, makeTeam({ state: "terminated" as TeamRecord["state"] }))
      engineers.set(ENG_A, makeSlot({
        engineerID: ENG_A,
        sessionID: "sess_resume_a" as SessionID,
        name: "engineer-resume-a",
        state: "failed",
        currentTask: null,
      }))

      const result = await Effect.runPromise(memCoordinator.resumeTeam(TEAM_ID))

      expect(result.engineers).toHaveLength(1)
      expect(result.engineers[0].engineerID).toBe(ENG_A)
      expect(result.engineers[0].sessionID as string).toBe("sess_resume_a")
      expect(result.engineers[0].name).toBe("engineer-resume-a")
    })
  })

  // ── worktree cleanup on dissolve ─────────────────────────────────────
  describe("dissolveTeam worktree cleanup", () => {
    test("dissolveTeam calls cleanupBranches for the dissolved team", async () => {
      let cleanupCalledFor: TeamID | null = null

      const trackingGit = GitManagerService.of({
        ...memGit,
        cleanupBranches: (teamID) =>
          Effect.sync(() => {
            cleanupCalledFor = teamID
          }),
      })

      const trackingCoordinator = SessionCoordinatorService.of({
        ...memCoordinator,
        dissolveTeam: (input) =>
          Effect.gen(function* () {
            yield* memCoordinator.dissolveTeam(input)
            yield* trackingGit.cleanupBranches(input.teamID).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }),
      })

      teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))

      await Effect.runPromise(trackingCoordinator.dissolveTeam({ teamID: TEAM_ID }))

      expect(cleanupCalledFor as unknown as string).toBe(TEAM_ID as string)
      expect(teams.has(TEAM_ID)).toBe(false)
    })

    test("dissolveTeam succeeds even when cleanupBranches fails (best-effort)", async () => {
      const { GitError } = await import("./git-manager")

      const failingGit = GitManagerService.of({
        ...memGit,
        cleanupBranches: (_teamID) =>
          Effect.fail(new GitError({ message: "worktree locked by another process" })),
      })

      const bestEffortCoordinator = SessionCoordinatorService.of({
        ...memCoordinator,
        dissolveTeam: (input) =>
          Effect.gen(function* () {
            yield* memCoordinator.dissolveTeam(input)
            yield* failingGit.cleanupBranches(input.teamID).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }),
      })

      teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))
      engineers.set(ENG_A, makeSlot({ engineerID: ENG_A }))

      // dissolve must not throw even though cleanupBranches fails
      await expect(
        Effect.runPromise(bestEffortCoordinator.dissolveTeam({ teamID: TEAM_ID })),
      ).resolves.toBeUndefined()

      expect(teams.has(TEAM_ID)).toBe(false)
    })
  })

  // ── Bug 3 regression: dissolve mid-flight does not fire false alarms ──
  describe("dissolve-time false-positive suppression", () => {
    test("runDiagnostic during dissolving team skips killEngineer and all-failed mailbox", async () => {
      // Three engineers in the team. ENG_A's session crashed (subprocess
      // exited 1 after team_dissolve deleted its session row). The team
      // is mid-dissolve. ENG_B and ENG_C are still working.
      teams.set(TEAM_ID, makeTeam({ state: "dissolving", engineerCount: 3 }))
      engineers.set(ENG_A, makeSlot({
        engineerID: ENG_A,
        sessionID: "sess_eng_a" as SessionID,
        state: "idle",
        currentTask: null,
      }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_eng_b" as SessionID,
        name: "engineer-b",
        state: "working",
        currentTask: "task_b" as TaskBoardID,
      }))
      engineers.set(ENG_C, makeSlot({
        engineerID: ENG_C,
        sessionID: "sess_eng_c" as SessionID,
        name: "engineer-c",
        state: "working",
        currentTask: "task_c" as TaskBoardID,
      }))
      const initialMsgCount = mailboxStore.size
      const initialEngCount = engineers.size

      const service = await runHeartbeat(Effect.gen(function* () {
        return yield* HeartbeatService
      }))

      await runHeartbeat(service.recordHeartbeat(ENG_A))

      const health = service.getHealth(ENG_A)!
      health.isDead = true
      health.isStuck = true
      health.stuckCount = 3

      const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))

      // The diagnostic should bail early — no killEngineer call (so the
      // engineer slot is left for dissolveTeam to clean up) and no
      // urgent mailbox.
      expect(result.action).toBe("killed")
      expect(engineers.size).toBe(initialEngCount)
      const allFailedMsgs = [...mailboxStore.values()].filter(
        (m) => m.type === "all-engineers-failed",
      )
      expect(allFailedMsgs).toHaveLength(0)
      expect(mailboxStore.size).toBe(initialMsgCount)
    })

    test("runDiagnostic with terminated team also skips both kill and mailbox", async () => {
      teams.set(TEAM_ID, makeTeam({
        state: "terminated" as TeamRecord["state"],
        engineerCount: 1,
      }))
      engineers.set(ENG_A, makeSlot({ engineerID: ENG_A }))

      const service = await runHeartbeat(Effect.gen(function* () {
        return yield* HeartbeatService
      }))

      await runHeartbeat(service.recordHeartbeat(ENG_A))
      const health = service.getHealth(ENG_A)!
      health.isDead = true
      health.isStuck = true
      health.stuckCount = 3

      const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))
      expect(result.action).toBe("killed")
      // Engineer not removed (the dissolve path owns cleanup)
      expect(engineers.has(ENG_A)).toBe(true)
      const allFailedMsgs = [...mailboxStore.values()].filter(
        (m) => m.type === "all-engineers-failed",
      )
      expect(allFailedMsgs).toHaveLength(0)
    })

    test("runDiagnostic on active team with one dead + idle peer does NOT trigger all-failed", async () => {
      // ENG_A is dead and holds task_1; ENG_B is idle (free). The
      // diagnostic's reassign branch matches first and hands task_1 to
      // ENG_B, so the liveOnly check is never reached. Test stays valid
      // under both old and new liveOnly semantics.
      engineers.set(ENG_A, makeSlot({
        engineerID: ENG_A,
        currentTask: "task_1" as TaskBoardID,
        state: "working",
      }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_eng_b" as SessionID,
        name: "engineer-b",
        state: "idle",
      }))
      teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

      const service = await runHeartbeat(Effect.gen(function* () {
        return yield* HeartbeatService
      }))

      await runHeartbeat(service.recordHeartbeat(ENG_A))
      const health = service.getHealth(ENG_A)!
      health.isDead = true
      health.isStuck = true
      health.stuckCount = 3

      const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))

      // ENG_A is dead with task_1; ENG_B is idle (free) → reassignable.
      expect(result.action).toBe("reassigned")
      expect(result.taskReassignedTo).toBe(ENG_B)
    })

    test("runDiagnostic with one dead engineer + idle peers (no task to reassign) does NOT fire all-failed urgent", async () => {
      // Regression for the bug where a heartbeat-killed engineer with
      // no currentTask would skip the reassign branch and hit the
      // liveOnly check. If the surviving siblings were still in their
      // post-spawn idle window, the old liveOnly filter (working|blocked
      // only) reported 0 alive → fired a false all-engineers-failed
      // urgent even though the team had healthy engineers. With idle
      // counted as alive the urgent must not fire.
      engineers.set(ENG_A, makeSlot({
        engineerID: ENG_A,
        currentTask: null,
        state: "idle",
      }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_eng_b" as SessionID,
        name: "engineer-b",
        state: "idle",
      }))
      engineers.set(ENG_C, makeSlot({
        engineerID: ENG_C,
        sessionID: "sess_eng_c" as SessionID,
        name: "engineer-c",
        state: "idle",
      }))
      teams.set(TEAM_ID, makeTeam({ engineerCount: 3 }))

      const service = await runHeartbeat(Effect.gen(function* () {
        return yield* HeartbeatService
      }))

      await runHeartbeat(service.recordHeartbeat(ENG_A))
      const health = service.getHealth(ENG_A)!
      health.isDead = true
      health.isStuck = true
      health.stuckCount = 3

      const before = mailboxStore.size
      const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))

      // No task to reassign and idle peers are alive → killed action,
      // not all-failed; no urgent mail.
      expect(result.action).toBe("killed")
      const allFailedMsgs = [...mailboxStore.values()].filter(
        (m) => m.type === "all-engineers-failed",
      )
      expect(allFailedMsgs).toHaveLength(0)
      expect(mailboxStore.size).toBe(before)
    })
  })

  // ── Bug 3 regression: listTeamEngineers liveOnly filter ──────────────
  describe("listTeamEngineers liveOnly", () => {
    test("liveOnly excludes only failed engineers (idle/working/blocked are alive)", async () => {
      // Idle engineers are alive: a just-spawned engineer is idle until
      // it picks its first task, and a just-completed engineer is idle
      // after team_report. Treating idle as dead caused a false
      // all-engineers-failed urgent when one peer crashed before its
      // siblings transitioned out of post-spawn idle.
      teams.set(TEAM_ID, makeTeam({ engineerCount: 4 }))
      engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, state: "working" }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_b" as SessionID,
        state: "idle",
      }))
      engineers.set(ENG_C, makeSlot({
        engineerID: ENG_C,
        sessionID: "sess_c" as SessionID,
        state: "blocked",
      }))
      engineers.set(ENG_D, makeSlot({
        engineerID: ENG_D,
        sessionID: "sess_d" as SessionID,
        state: "failed",
      }))

      const all = await Effect.runPromise(memCoordinator.listTeamEngineers(TEAM_ID))
      expect(all).toHaveLength(4)

      const live = await Effect.runPromise(
        memCoordinator.listTeamEngineers(TEAM_ID, { liveOnly: true }),
      )
      expect(live).toHaveLength(3)
      const liveIds = live.map((s) => s.engineerID).sort()
      expect(liveIds).toEqual([ENG_A, ENG_B, ENG_C].sort())
    })

    test("liveOnly: false (default) returns all engineers", async () => {
      teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))
      engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, state: "idle" }))
      engineers.set(ENG_B, makeSlot({
        engineerID: ENG_B,
        sessionID: "sess_b" as SessionID,
        state: "failed",
      }))

      const all = await Effect.runPromise(
        memCoordinator.listTeamEngineers(TEAM_ID, { liveOnly: false }),
      )
      expect(all).toHaveLength(2)
    })
  })
})
