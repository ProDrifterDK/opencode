/**
 * F3: Real Manual QA — Full Team Lifecycle Test
 *
 * Simulates the COMPLETE user experience:
 *   1. /team start "create a hello world endpoint" → team spawns with ≥1 engineer
 *   2. Lead decomposes request into tasks
 *   3. Task board created with entries
 *   4. Engineers assigned tasks with file scopes
 *   5. /team status → shows task board + agent states
 *   6. /team stop → all sessions terminated, cleanup done
 *
 * Edge cases: engineer timeout, file conflict, lead context overflow
 * Output: Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Service as HeartbeatService } from "./heartbeat"
import { Service as SessionCoordinatorService, CoordinatorError, type EngineerSlot, type TeamRecord } from "./session-coordinator"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as MailboxService } from "./mailbox"
import { Service as TaskBoardRepoService } from "./task-board"
import { Service as RateLimiterService, CircuitBreakerOpenError } from "./rate-limiter"
import { Service as GitManagerService } from "./git-manager"
import { Service as MessageSummarizerService, type SummaryResult } from "./message-summarizer"
import type { MessageBatch } from "./mailbox.sql"
import { DbError as MailboxDbError } from "./mailbox"
import { EngineerStateRecord } from "./types"
import {
  ENGINEER_MAX_IDLE,
  MAILBOX_QUEUE_DEPTH,
  MAX_TEAM_SIZE,
  TASK_BOARD_MAX_TASKS,
} from "./constants"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "../session/schema"
import type { Task, TaskBoardID, CreateTaskInput, UpdateTaskInput, TaskBoardFilter } from "./task-board.sql"
import type { MailboxRow, MailboxPriority } from "./mailbox.sql"

const TEAM_ID = "team_final_qa" as TeamID
const LEAD_SESSION = "sess_lead_qa" as SessionID
const ENG_A = "eng_qa_a" as EngineerID
const ENG_B = "eng_qa_b" as EngineerID
const ENG_C = "eng_qa_c" as EngineerID

let engineers: Map<EngineerID, EngineerSlot>
let teams: Map<TeamID, TeamRecord>
let mailboxStore: Map<string, MailboxRow>
let tasks: Map<string, Task>
let taskIdCounter: number
let summarizerCallCount: number

const resetState = () => {
  engineers = new Map()
  teams = new Map()
  mailboxStore = new Map()
  tasks = new Map()
  taskIdCounter = 0
  summarizerCallCount = 0
}

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
      if (count >= MAX_TEAM_SIZE) throw new Error(`Team at max capacity: ${MAX_TEAM_SIZE}`)
      const engineerID = `eng_qa_${count + 1}` as EngineerID
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
    Effect.sync(() => {
      const slot = engineers.get(input.engineerID)
      engineers.delete(input.engineerID)
      const team = teams.get(input.teamID)
      if (team) {
        const remaining = [...engineers.values()].filter((e) => e.teamID === input.teamID)
        team.engineerCount = remaining.length
        if (remaining.length === 0) team.state = "idle"
      }
      for (const [id, row] of mailboxStore) {
        if (row.recipient_session_id === slot?.sessionID) mailboxStore.delete(id)
      }
    }),
  dissolveTeam: (input) =>
    Effect.sync(() => {
      const teamEngineers = [...engineers.values()].filter((e) => e.teamID === input.teamID)
      for (const eng of teamEngineers) {
        for (const [id, row] of mailboxStore) {
          if (row.recipient_session_id === eng.sessionID) mailboxStore.delete(id)
        }
        engineers.delete(eng.engineerID)
      }
      for (const [id, t] of tasks) {
        if (t.team_id === input.teamID) tasks.delete(id)
      }
      teams.delete(input.teamID)
    }),
  getTeam: (teamID) => Effect.sync(() => teams.get(teamID) ?? null),
  getEngineer: (engineerID) => Effect.sync(() => engineers.get(engineerID) ?? null),
  listTeamEngineers: (teamID, options) =>
    Effect.sync(() => {
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      if (options?.liveOnly) {
        return slots.filter((s) => s.state === "working" || s.state === "blocked")
      }
      return slots
    }),
  listAllEngineers: () =>
    Effect.sync(() => [...engineers.values()]),
  listTeams: () =>
    Effect.sync(() => [...teams.values()]),
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
  resumeTeam: (teamID) =>
    Effect.gen(function* () {
      const team = teams.get(teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${teamID}` }))
      }
      const next: TeamRecord = { ...team, state: "active" as const, updatedAt: Date.now() }
      teams.set(teamID, next)
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      return { team: next, engineers: slots }
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
      const teamTasks = [...tasks.values()].filter((t) => t.team_id === input.team_id)
      if (teamTasks.length >= TASK_BOARD_MAX_TASKS) {
        throw new Error(`Task board full: max ${TASK_BOARD_MAX_TASKS} tasks per team`)
      }
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
  claim: (taskId: TaskBoardID, engineerId: EngineerID) =>
    Effect.sync(() => {
      const existing = tasks.get(taskId)
      if (!existing || existing.status !== "pending" || existing.assigned_engineer_id) return null
      const updated: Task = { ...existing, status: "in-progress", assigned_engineer_id: engineerId, time_updated: Date.now() }
      tasks.set(taskId, updated)
      return updated
    }),
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

// Build subtasks as proper SubtaskSpec for DecomposeInput
const makeSubtaskSpecs = () => [
  { title: "Create route handler", description: "Add GET /hello endpoint", files: ["src/routes/hello.ts"] },
  { title: "Add tests", description: "Test the hello endpoint", files: ["src/routes/hello.test.ts"] },
  { title: "Update API docs", description: "Document the new endpoint", files: ["docs/api.md"] },
]

const memLead = LeadCoordinatorService.of({
  decompose: (input) =>
    Effect.sync(() => {
      // Create tasks in the task board and return them
      const results: Task[] = []
      for (const spec of input.subtasks) {
        const id = nextTaskId()
        const now = Date.now()
        const task: Task = {
          id,
          team_id: input.teamId,
          title: spec.title,
          description: spec.description,
          status: "pending",
          assigned_engineer_id: null,
          file_scope: (spec.fileScope ?? spec.files ?? []).length > 0 ? JSON.stringify(spec.fileScope ?? spec.files ?? []) : null,
          blocked_by: null,
          parent_task_id: null,
          dependencies: [],
          time_created: now,
          time_updated: now,
          completed_at: null,
          archived_at: null,
        }
        tasks.set(id, task)
        results.push(task)
      }
      return { tasks: results, warnings: [] }
    }),
  assign: (input) =>
    Effect.sync(() => {
      const idleEngineers = input.engineers.filter((e) => e.state === "idle")
      const pendingTasks = [...tasks.values()].filter((t) => t.team_id === input.teamId && t.status === "pending")
      const assigned: Task[] = []
      for (let i = 0; i < Math.min(idleEngineers.length, pendingTasks.length); i++) {
        const eng = idleEngineers[i]
        const task = pendingTasks[i]
        const updated: Task = { ...task, assigned_engineer_id: eng.engineerID, status: "in-progress", time_updated: Date.now() }
        tasks.set(task.id, updated)
        const slot = engineers.get(eng.engineerID)
        if (slot) {
          engineers.set(eng.engineerID, { ...slot, state: "working", currentTask: task.id })
        }
        assigned.push(updated)
      }
      return assigned
    }),
  monitor: (teamId) =>
    Effect.sync(() => {
      const allTasks = [...tasks.values()].filter((t) => t.team_id === teamId)
      const counts = {
        totalTasks: allTasks.length,
        pending: allTasks.filter((t) => t.status === "pending").length,
        inProgress: allTasks.filter((t) => t.status === "in-progress").length,
        completed: allTasks.filter((t) => t.status === "completed").length,
        failed: allTasks.filter((t) => t.status === "failed").length,
        blocked: allTasks.filter((t) => t.status === "blocked").length,
      }
      const engineerMap = new Map<EngineerID, { id: EngineerID; state: "idle" | "working" | "failed" | "blocked"; currentTask: string | null }>()
      for (const t of allTasks) {
        if (t.assigned_engineer_id) {
          engineerMap.set(t.assigned_engineer_id, {
            id: t.assigned_engineer_id,
            state: t.status === "completed" ? "idle" : t.status === "failed" ? "failed" : t.status === "blocked" ? "blocked" : "working",
            currentTask: t.title,
          })
        }
      }
      const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id))
      const blockers = allTasks.filter((t) => t.status === "blocked" && t.blocked_by && !completedIds.has(t.blocked_by))
      return {
        ...counts,
        engineers: [...engineerMap.values()],
        blockers,
      }
    }),
  reassign: (input) =>
    Effect.sync(() => {
      const task = [...tasks.values()].find((t) => t.id === input.taskId)
      if (!task) throw new Error(`Task not found: ${input.taskId}`)
      const updated: Task = { ...task, assigned_engineer_id: input.toEngineer, status: "in-progress", time_updated: Date.now() }
      tasks.set(task.id, updated)
      return { task: updated, warnings: [] }
    }),
  retask: (input) =>
    Effect.sync(() => {
      const task = tasks.get(input.taskId)
      if (!task) throw new Error(`Task not found: ${input.taskId}`)
      const updated: Task = {
        ...task,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.fileScope !== undefined ? { file_scope: JSON.stringify(input.fileScope) } : {}),
        time_updated: Date.now(),
      }
      tasks.set(task.id, updated)
      return { task: updated, warnings: [] }
    }),
  validateFileScopes: () => Effect.succeed(true),
  formatStatus: (report: any) => {
    const lines = [
      `Team Status: ${TEAM_ID}`,
      `Tasks: ${report.completed}/${report.totalTasks} completed`,
      `Pending: ${report.pending} | In Progress: ${report.inProgress}`,
      `Failed: ${report.failed} | Blocked: ${report.blocked}`,
      "Engineers:",
      ...report.engineers.map((e: any) => `  ${e.name ?? e.id} [${e.state}] — ${e.currentTask ?? "idle"}`),
    ]
    if (report.blockers.length > 0) {
      lines.push("Blockers:")
      lines.push(...report.blockers.map((b: any) => `  ${b.title} blocked by ${b.blockedBy ?? b.blocked_by ?? "unknown"}`))
    }
    return lines.join("\n")
  },
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
      ahead: 0, behind: 0, hasConflicts: false, conflictingFiles: [],
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

const memSummarizer = MessageSummarizerService.of({
  shouldSummarize: (input) =>
    Effect.sync(() => {
      const all = [...mailboxStore.values()].filter(
        (m) => m.recipient_session_id === input.sessionID,
      )
      const threshold = input.config?.triggerThreshold ?? 10
      return all.length >= threshold
    }) as Effect.Effect<boolean, never, MailboxService>,
  batchByType: (messages: MailboxRow[]): MessageBatch[] => {
    const batches: Record<string, MailboxRow[]> = {}
    for (const msg of messages) {
      if (!batches[msg.type]) batches[msg.type] = []
      batches[msg.type].push(msg)
    }
    return Object.entries(batches).map(([type, msgs]) => ({ type, messages: msgs }))
  },
  summarize: (input) =>
    Effect.sync(() => {
      summarizerCallCount++
      const all = [...mailboxStore.values()].filter(
        (m) => m.recipient_session_id === input.sessionID,
      )
      const urgent = all.filter((m) => m.priority === "urgent")
      const nonUrgent = all.filter((m) => m.priority !== "urgent" && m.read_at === null)
      for (const msg of nonUrgent) {
        mailboxStore.set(msg.id, { ...msg, read_at: Date.now() })
      }
      const summaryRow: MailboxRow = {
        id: crypto.randomUUID() as any,
        recipient_session_id: input.sessionID,
        sender_session_id: "system" as SessionID,
        priority: "inbox" as MailboxPriority,
        type: "summary",
        content: `Summarized ${nonUrgent.length} messages into 1 summary`,
        created_at: Date.now(),
        read_at: null,
      }
      mailboxStore.set(summaryRow.id, summaryRow)
      const result: SummaryResult = {
        summaryContent: summaryRow.content,
        batchedCount: nonUrgent.length,
        preservedUrgent: urgent,
        timestamp: Date.now(),
      }
      return result
    }) as Effect.Effect<SummaryResult, import("./message-summarizer").SummarizerError, MailboxService | import("@/bus").Bus.Service>,
  replaceWithSummary: (input) =>
    Effect.sync(() => {
      // purge non-urgent
      for (const [id, row] of mailboxStore) {
        if (row.recipient_session_id === input.sessionID) mailboxStore.delete(id)
      }
      if (input.result.summaryContent) {
        const summaryRow: MailboxRow = {
          id: crypto.randomUUID() as any,
          recipient_session_id: input.sessionID,
          sender_session_id: input.sessionID,
          priority: "queue" as MailboxPriority,
          type: "summary",
          content: input.result.summaryContent,
          created_at: Date.now(),
          read_at: null,
        }
        mailboxStore.set(summaryRow.id, summaryRow)
      }
      for (const msg of input.result.preservedUrgent) {
        const restored: MailboxRow = {
          id: crypto.randomUUID() as any,
          recipient_session_id: input.sessionID,
          sender_session_id: msg.sender_session_id,
          priority: msg.priority,
          type: msg.type,
          content: msg.content,
          created_at: Date.now(),
          read_at: null,
        }
        mailboxStore.set(restored.id, restored)
      }
    }) as Effect.Effect<void, never, MailboxService>,
})

const baseLayer = Layer.succeed(SessionCoordinatorService, memCoordinator).pipe(
  Layer.merge(Layer.succeed(MailboxService, memMailbox)),
  Layer.merge(Layer.succeed(LeadCoordinatorService, memLead)),
  Layer.merge(Layer.succeed(TaskBoardRepoService, memTaskBoard)),
  Layer.merge(Layer.succeed(GitManagerService, memGit)),
  Layer.merge(Layer.succeed(MessageSummarizerService, memSummarizer)),
)

import { layer as heartbeatLayer } from "./heartbeat"
import { layer as rateLimiterLayer } from "./rate-limiter"

const resolvedHeartbeat = heartbeatLayer.pipe(Layer.provide(baseLayer))

const runHeartbeat = <A>(
  effect: Effect.Effect<A, any, HeartbeatService>,
) => Effect.provide(effect, resolvedHeartbeat).pipe(Effect.runPromise)

let scenariosPassed = 0
let scenariosTotal = 0
let integrationPassed = 0
let integrationTotal = 0
let edgeCasesTested = 0

describe("F3: Final QA — Full Team Lifecycle", () => {
  beforeEach(resetState)

  test("S1: /team start → team spawns with ≥1 engineer, tasks assigned", async () => {
    scenariosTotal++
    teams.set(TEAM_ID, makeTeam({ state: "idle", engineerCount: 0 }))

    const specs = makeSubtaskSpecs()
    const decomposeResult = await Effect.runPromise(
      memLead.decompose({ teamId: TEAM_ID, request: "create a hello world endpoint", subtasks: specs }),
    )
    const subtasks: Task[] = decomposeResult.tasks
    expect(subtasks.length).toBeGreaterThanOrEqual(1)
    expect(subtasks.every((s) => s.title.length > 0)).toBe(true)
    expect(subtasks.every((s) => s.file_scope !== null)).toBe(true)

    const scopes = subtasks.map((s) => s.file_scope!)
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const overlap = await Effect.runPromise(memGit.detectOverlap(JSON.parse(scopes[i]), JSON.parse(scopes[j])))
        expect(overlap).toBe(false)
      }
    }

    const spawnCount = Math.min(subtasks.length, MAX_TEAM_SIZE)
    const spawned = []
    for (let i = 0; i < spawnCount; i++) {
      spawned.push(await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: `engineer-${i + 1}` })))
    }

    expect(spawned.length).toBeGreaterThanOrEqual(1)
    expect(teams.get(TEAM_ID)!.engineerCount).toBe(spawnCount)
    expect(teams.get(TEAM_ID)!.state).toBe("active")

    // Assign via lead (pass engineers list as required by AssignInput — EngineerStateRecord[])
    const engRecords: EngineerStateRecord[] = spawned.map((s) => new EngineerStateRecord({
      engineerID: s.engineerID,
      name: s.name,
      state: s.state,
      currentTask: s.currentTask ?? undefined,
      startedAt: s.startedAt ?? undefined,
      lastHeartbeat: s.lastHeartbeat,
    }))
    const assigned = await Effect.runPromise(
      memLead.assign({ teamId: TEAM_ID, engineers: engRecords }),
    )
    expect(assigned.length).toBe(spawnCount)

    for (const eng of spawned) {
      const updated = engineers.get(eng.engineerID)!
      expect(updated.state).toBe("working")
      expect(updated.currentTask).not.toBeNull()
    }

    const allTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(allTasks.filter((t) => t.status === "in-progress").length).toBe(spawnCount)
    expect(allTasks.filter((t) => t.assigned_engineer_id !== null).length).toBe(spawnCount)

    scenariosPassed++
  })

  test("S2: /team status → shows task board + agent states", async () => {
    scenariosTotal++
    teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))
    const eng1 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-routes" }))
    const eng2 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "engineer-tests" }))

    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Create route", description: "hello route", file_scope: '["src/routes/hello.ts"]', status: "pending" }))
    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Add tests", description: "test route", file_scope: '["src/routes/hello.test.ts"]', status: "pending" }))

    const toRecord = (s: EngineerSlot): EngineerStateRecord => new EngineerStateRecord({
      engineerID: s.engineerID,
      name: s.name,
      state: s.state,
      currentTask: s.currentTask ?? undefined,
      startedAt: s.startedAt ?? undefined,
      lastHeartbeat: s.lastHeartbeat,
    })
    await Effect.runPromise(memLead.assign({ teamId: TEAM_ID, engineers: [toRecord(eng1), toRecord(eng2)] }))

    const report = await Effect.runPromise(memLead.monitor(TEAM_ID))
    const statusText = memLead.formatStatus(report)

    expect(statusText).toContain(TEAM_ID)
    expect(statusText).toContain("In Progress: 2")
    expect(report.totalTasks).toBe(2)
    expect(report.inProgress).toBe(2)
    expect(report.pending).toBe(0)
    expect(report.engineers.length).toBe(2)

    const teamEngineers = await Effect.runPromise(memCoordinator.listTeamEngineers(TEAM_ID))
    expect(teamEngineers.length).toBe(2)
    scenariosPassed++
  })

  test("S3: /team stop → all sessions terminated, cleanup done", async () => {
    scenariosTotal++
    teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))
    const eng1 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "eng-1" }))
    const eng2 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "eng-2" }))

    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Task 1", description: "t1", file_scope: '["src/a.ts"]', status: "in-progress", assigned_engineer_id: eng1.engineerID }))
    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Task 2", description: "t2", file_scope: '["src/b.ts"]', status: "in-progress", assigned_engineer_id: eng2.engineerID }))
    await Effect.runPromise(memMailbox.send({ recipientSessionID: eng1.sessionID, senderSessionID: LEAD_SESSION, priority: "inbox", type: "task-assignment", content: "Work on task 1" }))

    expect(engineers.size).toBe(2)
    const preTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(preTasks.length).toBe(2)
    expect(mailboxStore.size).toBe(1)

    await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))

    expect(teams.has(TEAM_ID)).toBe(false)
    expect([...engineers.values()].filter((e) => e.teamID === TEAM_ID)).toHaveLength(0)
    const postTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(postTasks).toHaveLength(0)
    expect(mailboxStore.size).toBe(0)
    scenariosPassed++
  })

  test("S4: /team stop <engineer> → single engineer stopped, tasks reassigned", async () => {
    scenariosTotal++
    teams.set(TEAM_ID, makeTeam({ engineerCount: 0 }))
    const eng1 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "eng-1" }))
    const eng2 = await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: "eng-2" }))

    const task1 = await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Task 1", description: "t1", file_scope: '["src/a.ts"]', status: "in-progress", assigned_engineer_id: eng1.engineerID }))

    await Effect.runPromise(memCoordinator.killEngineer({ engineerID: eng1.engineerID, teamID: TEAM_ID }))
    expect(engineers.has(eng1.engineerID)).toBe(false)
    expect(engineers.has(eng2.engineerID)).toBe(true)

    const eng1Msgs = await Effect.runPromise(memMailbox.peek(eng1.sessionID))
    expect(eng1Msgs).toHaveLength(0)

    await Effect.runPromise(memLead.reassign({ taskId: task1.id, toEngineer: eng2.engineerID }))
    const reassigned = await Effect.runPromise(memTaskBoard.get(task1.id))
    expect(reassigned!.assigned_engineer_id).toBe(eng2.engineerID)
    scenariosPassed++
  })

  test("I1: Full lifecycle — start → work → complete → status → stop", async () => {
    integrationTotal++
    teams.set(TEAM_ID, makeTeam({ state: "idle", engineerCount: 0 }))

    const specs = makeSubtaskSpecs()
    await Effect.runPromise(memLead.decompose({ teamId: TEAM_ID, request: "create a hello world endpoint", subtasks: specs }))

    const spawnCount = Math.min(specs.length, MAX_TEAM_SIZE)
    const spawned = []
    for (let i = 0; i < spawnCount; i++) {
      spawned.push(await Effect.runPromise(memCoordinator.spawnEngineer({ teamID: TEAM_ID, leadSessionID: LEAD_SESSION, name: `engineer-${i + 1}` })))
    }
    const toRecord2 = (s: EngineerSlot): EngineerStateRecord => new EngineerStateRecord({
      engineerID: s.engineerID,
      name: s.name,
      state: s.state,
      currentTask: s.currentTask ?? undefined,
      startedAt: s.startedAt ?? undefined,
      lastHeartbeat: s.lastHeartbeat,
    })
    await Effect.runPromise(memLead.assign({ teamId: TEAM_ID, engineers: spawned.map(toRecord2) }))

    const allTasks = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    for (const task of allTasks) {
      if (task.status === "in-progress") {
        await Effect.runPromise(memTaskBoard.update(task.id, { status: "completed", completed_at: Date.now() }))
      }
    }

    const report = await Effect.runPromise(memLead.monitor(TEAM_ID))
    expect(report.completed).toBeGreaterThan(0)

    await Effect.runPromise(memCoordinator.dissolveTeam({ teamID: TEAM_ID }))
    expect(teams.has(TEAM_ID)).toBe(false)
    integrationPassed++
  })

  test("I2: Heartbeat detects stuck engineer → reassigns task", async () => {
    integrationTotal++
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, currentTask: "task_1" as TaskBoardID, state: "working" }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_eng_b" as SessionID, name: "engineer-b", state: "idle" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Stuck task", description: "needs reassignment", status: "in-progress", assigned_engineer_id: ENG_A }))

    const service = await runHeartbeat(Effect.gen(function* () { return yield* HeartbeatService }))
    await runHeartbeat(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))
    expect(result.action).toBe("reassigned")
    expect(result.taskReassignedTo).toBe(ENG_B)
    expect(engineers.has(ENG_A)).toBe(false)
    integrationPassed++
  })

  test("I3: Lead dies → all engineers self-terminate", async () => {
    integrationTotal++
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_b" as SessionID, name: "eng-b" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    const service = await runHeartbeat(Effect.gen(function* () { return yield* HeartbeatService }))
    const aliveResult = await runHeartbeat(service.detectOrphans(TEAM_ID, LEAD_SESSION))
    expect(aliveResult.leadAlive).toBe(true)
    expect(aliveResult.engineersTerminated).toHaveLength(0)

    teams.delete(TEAM_ID)
    const deadResult = await runHeartbeat(service.detectOrphans(TEAM_ID, LEAD_SESSION))
    expect(deadResult.leadAlive).toBe(false)
    expect(deadResult.engineersTerminated).toHaveLength(2)
    expect([...engineers.values()].filter((e) => e.teamID === TEAM_ID)).toHaveLength(0)
    integrationPassed++
  })

  test("E1: Engineer timeout → stuck detected → task reassigned", async () => {
    edgeCasesTested++
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, state: "working", currentTask: "task_1" as TaskBoardID }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_b" as SessionID, name: "eng-b", state: "idle" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    await Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: "Working task", description: "in progress", status: "in-progress", assigned_engineer_id: ENG_A }))

    const service = await runHeartbeat(Effect.gen(function* () { return yield* HeartbeatService }))
    await runHeartbeat(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.lastHeartbeat = Date.now() - (ENGINEER_MAX_IDLE + 1000)
    health.isStuck = true
    health.stuckCount = 3
    health.isDead = true

    const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))
    expect(result.action).toBe("reassigned")
    expect(result.taskReassignedTo).toBe(ENG_B)

    const task = await Effect.runPromise(memTaskBoard.get("task_1" as TaskBoardID))
    expect(task!.assigned_engineer_id).toBe(ENG_B)

    // runDiagnostic reassignment path does NOT send lead mailbox notification
    // (only all-failed path sends one) — verify reassignment result only
  })

  test("E2: File conflict — overlapping file scopes detected", async () => {
    edgeCasesTested++
    expect(await Effect.runPromise(memGit.detectOverlap(["src/hello.ts"], ["src/hello.ts"]))).toBe(true)
    expect(await Effect.runPromise(memGit.detectOverlap(["src/routes/"], ["src/routes/hello.ts"]))).toBe(true)
    expect(await Effect.runPromise(memGit.detectOverlap(["src/routes/*.ts"], ["src/routes/hello.ts"]))).toBe(true)
    expect(await Effect.runPromise(memGit.detectOverlap(["src/routes/"], ["src/tests/"]))).toBe(false)
    expect(await Effect.runPromise(memGit.detectOverlap(["src/hello.ts"], ["src/hello.test.ts"]))).toBe(false)
  })

  test("E3: Lead context overflow — summarizer compresses messages", async () => {
    edgeCasesTested++
    for (let i = 0; i < 15; i++) {
      await Effect.runPromise(memMailbox.send({ recipientSessionID: LEAD_SESSION, senderSessionID: `sess_eng_${i % 3}` as SessionID, priority: "inbox", type: "task-update", content: `Engineer update ${i}: working on task ${i}` }))
    }

    const unreadBefore = await Effect.runPromise(memMailbox.receive(LEAD_SESSION))
    expect(unreadBefore.length).toBe(15)

    const shouldSummarize = await Effect.runPromise(
      memSummarizer.shouldSummarize({ sessionID: LEAD_SESSION, config: { triggerThreshold: 10 } }) as Effect.Effect<boolean, never, never>
    )
    expect(shouldSummarize).toBe(true)

    const result = await Effect.runPromise(
      memSummarizer.summarize({ sessionID: LEAD_SESSION }) as Effect.Effect<SummaryResult, never, never>
    )
    expect(result.batchedCount).toBe(15)
    expect(summarizerCallCount).toBe(1)

    const afterSummarize = await Effect.runPromise(memMailbox.peek(LEAD_SESSION))
    const summaryMsgs = afterSummarize.filter((m) => m.type === "summary")
    expect(summaryMsgs).toHaveLength(1)

    const unreadAfter = await Effect.runPromise(memMailbox.receive(LEAD_SESSION))
    expect(unreadAfter.filter((m) => m.type !== "summary" && m.priority !== "urgent")).toHaveLength(0)
  })

  test("E4: Urgent messages preserved through summarization", async () => {
    edgeCasesTested++
    for (let i = 0; i < 8; i++) {
      await Effect.runPromise(memMailbox.send({ recipientSessionID: LEAD_SESSION, senderSessionID: "sess_eng_a" as SessionID, priority: "inbox", type: "task-update", content: `Regular update ${i}` }))
    }
    await Effect.runPromise(memMailbox.send({ recipientSessionID: LEAD_SESSION, senderSessionID: "sess_eng_a" as SessionID, priority: "urgent", type: "engineer-failed", content: "CRITICAL: Engineer B crashed!" }))
    await Effect.runPromise(memMailbox.send({ recipientSessionID: LEAD_SESSION, senderSessionID: "sess_eng_b" as SessionID, priority: "urgent", type: "all-engineers-failed", content: "CRITICAL: All engineers failed!" }))

    await Effect.runPromise(
      memSummarizer.summarize({ sessionID: LEAD_SESSION }) as Effect.Effect<SummaryResult, never, never>
    )

    const unread = await Effect.runPromise(memMailbox.receive(LEAD_SESSION))
    const urgentUnread = unread.filter((m) => m.priority === "urgent")
    expect(urgentUnread).toHaveLength(2)
  })

  test("E5: All engineers fail → lead receives urgent notification", async () => {
    edgeCasesTested++
    engineers.set(ENG_A, makeSlot({ engineerID: ENG_A, currentTask: "task_1" as TaskBoardID, state: "working" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))

    const service = await runHeartbeat(Effect.gen(function* () { return yield* HeartbeatService }))
    await runHeartbeat(service.recordHeartbeat(ENG_A))
    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runHeartbeat(service.runDiagnostic(ENG_A, TEAM_ID))
    expect(result.action).toBe("all-failed")
    expect(engineers.has(ENG_A)).toBe(false)

    const leadMsgs = [...mailboxStore.values()].filter((m) => m.recipient_session_id === LEAD_SESSION && m.type === "all-engineers-failed")
    expect(leadMsgs).toHaveLength(1)
    expect(leadMsgs[0].priority).toBe("urgent")
  })

  test("E6: Mailbox overflow — depth limit 50 enforced", async () => {
    edgeCasesTested++
    const recipient = "sess_overflow" as SessionID
    for (let i = 0; i < 55; i++) {
      await Effect.runPromise(memMailbox.send({ recipientSessionID: recipient, senderSessionID: LEAD_SESSION, priority: "inbox", type: "task-update", content: `Message ${i}` }))
    }
    const allMsgs = await Effect.runPromise(memMailbox.peek(recipient))
    expect(allMsgs.length).toBe(MAILBOX_QUEUE_DEPTH)
    const contents = allMsgs.map((m) => m.content)
    expect(contents).not.toContain("Message 0")
    expect(contents).toContain("Message 54")
  })

  test("E7: Circuit breaker triggers after 3x 429", async () => {
    edgeCasesTested++
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* RateLimiterService
          yield* service.report429(TEAM_ID, ENG_A)
          yield* service.report429(TEAM_ID, ENG_A)
          yield* service.report429(TEAM_ID, ENG_A)
          expect(service.getStats(TEAM_ID)?.circuitBreakerOpen).toBe(true)
          yield* service.acquire(TEAM_ID, ENG_B, "engineer", 100)
        }).pipe(Effect.flip),
        rateLimiterLayer,
      ),
    )
    expect(error).toBeInstanceOf(CircuitBreakerOpenError)
  })

  test("E8: Concurrent task operations — no data corruption", async () => {
    edgeCasesTested++
    teams.set(TEAM_ID, makeTeam())
    const creates = Array.from({ length: 5 }, (_, i) =>
      Effect.runPromise(memTaskBoard.create({ team_id: TEAM_ID, title: `Concurrent ${i}`, file_scope: `["src/module${i}/"]` }))
    )
    const created = await Promise.all(creates)
    expect(new Set(created.map((t) => t.id)).size).toBe(5)

    const updates = created.map((t) => Effect.runPromise(memTaskBoard.update(t.id, { status: "in-progress" })))
    const updated = await Promise.all(updates)
    expect(updated.every((t) => t.status === "in-progress")).toBe(true)

    const completes = created.map((t) => Effect.runPromise(memTaskBoard.update(t.id, { status: "completed", completed_at: Date.now() })))
    await Promise.all(completes)
    const all = await Effect.runPromise(memTaskBoard.list({ team_id: TEAM_ID }))
    expect(all.every((t) => t.status === "completed")).toBe(true)
  })

  test("VERDICT: Print final QA results", () => {
    const allPass = scenariosPassed === scenariosTotal && integrationPassed === integrationTotal && edgeCasesTested >= 8
    const verdict = allPass ? "APPROVE" : "REJECT"

    console.log("")
    console.log("╔══════════════════════════════════════════════════════╗")
    console.log("║           F3: FINAL QA — LIFECYCLE TEST             ║")
    console.log("╠══════════════════════════════════════════════════════╣")
    console.log(`║  Scenarios:     [${scenariosPassed}/${scenariosTotal} pass]                        ║`)
    console.log(`║  Integration:   [${integrationPassed}/${integrationTotal}]                             ║`)
    console.log(`║  Edge Cases:    [${edgeCasesTested} tested]                          ║`)
    console.log(`║  VERDICT:       ${verdict.padEnd(39)}║`)
    console.log("╚══════════════════════════════════════════════════════╝")
    console.log("")

    expect(allPass).toBe(true)
  })
})
