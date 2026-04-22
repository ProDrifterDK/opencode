import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as HeartbeatService, type EngineerHealth, type DiagnosticResult, type OrphanStatus } from "./heartbeat"
import { Service as SessionCoordinatorService, type EngineerSlot, type TeamRecord } from "./session-coordinator"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as MailboxService } from "./mailbox"
import { ENGINEER_MAX_IDLE } from "./constants"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "../session/schema"
import type { Task, TaskBoardID, CreateTaskInput, UpdateTaskInput, TaskBoardFilter } from "./task-board.sql"

const ENG_A = "eng_a" as EngineerID
const ENG_B = "eng_b" as EngineerID
const ENG_C = "eng_c" as EngineerID
const TEAM_ID = "team_test" as TeamID
const LEAD_SESSION = "sess_lead" as SessionID

const makeSlot = (overrides: Partial<EngineerSlot> = {}): EngineerSlot => ({
  engineerID: ENG_A,
  teamID: TEAM_ID,
  sessionID: "sess_eng_a" as SessionID,
  name: "engineer-a",
  state: "idle",
  currentTask: null,
  startedAt: Date.now(),
  lastHeartbeat: Date.now(),
  ...overrides,
})

const makeTeam = (overrides: Partial<TeamRecord> = {}): TeamRecord => ({
  teamID: TEAM_ID,
  state: "active",
  leadSessionID: LEAD_SESSION,
  engineerCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
})

let engineers: Map<EngineerID, EngineerSlot>
let teams: Map<TeamID, TeamRecord>
let mailboxMessages: Map<string, { recipient: SessionID; type: string; content: string; priority: string }>
let mailboxUnread: Map<SessionID, boolean>

const resetState = () => {
  engineers = new Map()
  teams = new Map()
  mailboxMessages = new Map()
  mailboxUnread = new Map()
}

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
  spawnEngineer: () => Effect.sync(() => makeSlot()),
  resumeEngineer: () => Effect.sync(() => makeSlot()),
  killEngineer: (input: { engineerID: EngineerID; teamID: TeamID }) =>
    Effect.sync(() => {
      engineers.delete(input.engineerID)
      const team = teams.get(input.teamID)
      if (team) {
        team.engineerCount = Math.max(0, team.engineerCount - 1)
        if (team.engineerCount === 0) team.state = "idle"
      }
    }),
  dissolveTeam: (input: { teamID: TeamID }) =>
    Effect.sync(() => {
      teams.delete(input.teamID)
      engineers.clear()
    }),
  getTeam: (teamID: TeamID) => Effect.sync(() => teams.get(teamID) ?? null),
  getEngineer: (engineerID: EngineerID) => Effect.sync(() => engineers.get(engineerID) ?? null),
  listTeamEngineers: (teamID: TeamID) =>
    Effect.sync(() => [...engineers.values()].filter((e) => e.teamID === teamID)),
  listTeams: () => Effect.sync(() => [...teams.values()]),
})

const memLead = LeadCoordinatorService.of({
  decompose: () => Effect.succeed([]),
  assign: () => Effect.succeed([]),
  monitor: () => Effect.succeed({
    totalTasks: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, engineers: [], blockers: [],
  }),
  reassign: (input: { taskId: TaskBoardID; toEngineer: EngineerID }) =>
    Effect.sync(() => {
      return { id: input.taskId, assigned_engineer_id: input.toEngineer } as Task
    }),
  validateFileScopes: () => Effect.succeed(true),
  formatStatus: () => "",
})

const memMailbox = MailboxService.of({
  send: (input) =>
    Effect.sync(() => {
      const id = crypto.randomUUID() as any
      mailboxMessages.set(id, {
        recipient: input.recipientSessionID,
        type: input.type,
        content: input.content,
        priority: input.priority,
      })
      return {
        id,
        recipient_session_id: input.recipientSessionID,
        sender_session_id: input.senderSessionID,
        priority: input.priority as any,
        type: input.type,
        content: input.content,
        created_at: Date.now(),
        read_at: null,
      }
    }),
  receive: () => Effect.succeed([]),
  receiveByPriority: () => Effect.succeed([]),
  peek: () => Effect.succeed([]),
  markRead: () => Effect.void,
  purge: () => Effect.void,
  hasUnread: (input) =>
    Effect.sync(() => mailboxUnread.get(input.recipientSessionID) ?? false),
})

const testLayer = Layer.succeed(SessionCoordinatorService, memCoordinator).pipe(
  Layer.merge(Layer.succeed(MailboxService, memMailbox)),
  Layer.merge(Layer.succeed(LeadCoordinatorService, memLead)),
)

const heartbeatLayer = Layer.effect(HeartbeatService, Effect.gen(function* () {
  return yield* HeartbeatService
})).pipe(Layer.provide(testLayer))

import { layer } from "./heartbeat"

const resolvedLayer = layer.pipe(Layer.provide(testLayer))

const runWith = <A>(
  effect: Effect.Effect<A, any, HeartbeatService>,
) =>
  Effect.provide(effect, resolvedLayer).pipe(Effect.runPromise)

describe("HeartbeatMonitor", () => {
  beforeEach(resetState)

  test("recordHeartbeat updates health state", async () => {
    engineers.set(ENG_A, makeSlot({ lastHeartbeat: Date.now() - 100_000 }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)
    expect(health).not.toBeNull()
    expect(health!.isStuck).toBe(false)
    expect(health!.isDead).toBe(false)
    expect(health!.stuckCount).toBe(0)
  })

  test("checkHealth detects stuck engineer after ENGINEER_MAX_IDLE", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.lastHeartbeat = Date.now() - ENGINEER_MAX_IDLE - 1000

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results).toHaveLength(1)
    expect(results[0].isStuck).toBe(true)
    expect(results[0].stuckCount).toBe(1)
    expect(results[0].isDead).toBe(false)
  })

  test("checkHealth marks engineer dead after 3 stuck cycles", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.lastHeartbeat = Date.now() - ENGINEER_MAX_IDLE - 1000
    health.stuckCount = 2

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results[0].isStuck).toBe(true)
    expect(results[0].stuckCount).toBe(3)
    expect(results[0].isDead).toBe(true)
  })

  test("runDiagnostic kills dead engineer and reassigns task", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as any, state: "working" }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_eng_b" as SessionID, name: "engineer-b", state: "idle" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runWith(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.action).toBe("reassigned")
    expect(result.taskReassignedTo).toBe(ENG_B)
    expect(engineers.has(ENG_A)).toBe(false)
  })

  test("runDiagnostic sends all-failed message when no engineers remain", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as any }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runWith(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.action).toBe("all-failed")
    expect(engineers.has(ENG_A)).toBe(false)

    const msgs = [...mailboxMessages.values()]
    expect(msgs.some((m) => m.type === "all-engineers-failed")).toBe(true)
  })

  test("runDiagnostic returns healthy for responsive engineer", async () => {
    engineers.set(ENG_A, makeSlot())
    mailboxUnread.set("sess_eng_a" as SessionID, true)

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isStuck = true
    health.stuckCount = 1

    const result = await runWith(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.pingSucceeded).toBe(true)
    expect(result.action).toBe("healthy")
  })

  test("handleRateLimit applies exponential backoff", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))

    const health = service.getHealth(ENG_A)!
    expect(health.backoffUntil).not.toBeNull()
    expect(health.backoffUntil!).toBeGreaterThan(Date.now())

    const firstBackoff = health.backoffUntil!

    await runWith(service.handleRateLimit(ENG_A))
    expect(health.backoffUntil!).toBeGreaterThan(firstBackoff)
  })

  test("handleRateLimit circuit breaker after 3 consecutive 429s", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))

    const health = service.getHealth(ENG_A)!
    const remainingBackoff = health.backoffUntil! - Date.now()
    expect(remainingBackoff).toBeGreaterThan(4 * 60 * 1000)
  })

  test("recordHeartbeat clears rate limit state", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))
    await runWith(service.handleRateLimit(ENG_A))

    expect(service.getHealth(ENG_A)!.backoffUntil).not.toBeNull()

    await runWith(service.recordHeartbeat(ENG_A))

    expect(service.getHealth(ENG_A)!.backoffUntil).toBeNull()
  })

  test("handleCrash marks engineer dead and triggers diagnostic", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as any }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_eng_b" as SessionID, name: "engineer-b", state: "idle" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 2 }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const result = await runWith(service.handleCrash(ENG_A, TEAM_ID))

    expect(result.action).toBe("reassigned")
    expect(result.pingSucceeded).toBe(false)
    expect(engineers.has(ENG_A)).toBe(false)
  })

  test("detectOrphans returns healthy when lead is alive", async () => {
    teams.set(TEAM_ID, makeTeam())
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    const result = await runWith(service.detectOrphans(TEAM_ID, LEAD_SESSION))

    expect(result.leadAlive).toBe(true)
    expect(result.engineersTerminated).toHaveLength(0)
  })

  test("detectOrphans terminates engineers when lead is dead", async () => {
    teams.set(TEAM_ID, makeTeam())
    engineers.set(ENG_A, makeSlot())
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_eng_b" as SessionID, name: "engineer-b" }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    teams.delete(TEAM_ID)

    const result = await runWith(service.detectOrphans(TEAM_ID, LEAD_SESSION))

    expect(result.leadAlive).toBe(false)
    expect(result.engineersTerminated).toHaveLength(2)
    expect(result.engineersTerminated).toContain(ENG_A)
    expect(result.engineersTerminated).toContain(ENG_B)
  })

  test("detectOrphans terminates engineers when team is dissolving", async () => {
    teams.set(TEAM_ID, makeTeam({ state: "dissolving" }))
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    const result = await runWith(service.detectOrphans(TEAM_ID, LEAD_SESSION))

    expect(result.leadAlive).toBe(false)
    expect(result.engineersTerminated).toHaveLength(1)
  })

  test("checkHealth skips engineers in backoff", async () => {
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.lastHeartbeat = Date.now() - ENGINEER_MAX_IDLE - 1000
    health.backoffUntil = Date.now() + 60_000

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results).toHaveLength(1)
    expect(results[0].stuckCount).toBe(0)
  })
})
