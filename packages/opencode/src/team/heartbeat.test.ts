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
import type { MailboxID } from "./mailbox.sql"
import { clearAllTerminating, markTerminating } from "./daemon-running"

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
  engineerCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
})

let engineers: Map<EngineerID, EngineerSlot>
let teams: Map<TeamID, TeamRecord>
let mailboxMessages: Map<string, { recipient: SessionID; type: string; content: string; priority: string }>
let mailboxUnread: Map<SessionID, boolean>
let killEngineerCalls: Array<{ engineerID: EngineerID; teamID: TeamID; failureReason?: string }>

const resetState = () => {
  engineers = new Map()
  teams = new Map()
  mailboxMessages = new Map()
  mailboxUnread = new Map()
  killEngineerCalls = []
  clearAllTerminating()
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
  killEngineer: (input: { engineerID: EngineerID; teamID: TeamID; failureReason?: string }) =>
    Effect.sync(() => {
      killEngineerCalls.push(input)
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
  listTeamEngineers: (teamID: TeamID, options?: { liveOnly?: boolean }) =>
    Effect.sync(() => {
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      if (options?.liveOnly) {
        return slots.filter((s) => s.state !== "failed")
      }
      return slots
    }),
  listAllEngineers: () => Effect.sync(() => [...engineers.values()]),
  listTeams: () => Effect.sync(() => [...teams.values()]),
  isLead: () => Effect.succeed(false),
  isEngineer: () => Effect.succeed(false),
  getEngineerBySession: () => Effect.succeed(null),
  updateEngineer: (engineerID: EngineerID) =>
    Effect.sync(() => {
      const slot = engineers.get(engineerID)
      if (slot) slot.lastHeartbeat = Date.now()
      return slot ?? makeSlot({ engineerID })
    }),
  getTeamForSession: () => Effect.succeed(null),
  resumeTeam: (teamID) =>
    Effect.sync(() => {
      const team = teams.get(teamID)
      if (!team) throw new Error(`Team not found: ${teamID}`)
      const slots = [...engineers.values()].filter((e) => e.teamID === teamID)
      return { team: { ...team, state: "active" as const }, engineers: slots }
    }),
})

const memLead = LeadCoordinatorService.of({
  decompose: () => Effect.succeed({ tasks: [], warnings: [] }),
  assign: () => Effect.succeed([]),
  monitor: () => Effect.succeed({
    totalTasks: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, engineers: [], blockers: [],
  }),
  reassign: (input: { taskId: TaskBoardID; toEngineer: EngineerID }) =>
    Effect.sync(() => {
      return { task: { id: input.taskId, assigned_engineer_id: input.toEngineer } as Task, warnings: [] }
    }),
  retask: (input) =>
    Effect.sync(() => {
      return { task: { id: input.taskId } as import("./task-board.sql").Task, warnings: [] }
    }),
  validateFileScopes: () => Effect.succeed(true),
  formatStatus: () => "",
})

const memMailbox = MailboxService.of({
  send: (input) =>
    Effect.sync(() => {
      const id = crypto.randomUUID() as MailboxID
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
        priority: input.priority,
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
  purgeOlderThan: (_maxAgeMs) => Effect.succeed(0),
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
  effect: Effect.Effect<A, unknown, HeartbeatService>,
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
    // Source of liveness is the engineer slot's `lastHeartbeat` in DB
    // (not the in-memory health record), so the test must age the slot
    // to trigger the stuck threshold.
    engineers.set(ENG_A, makeSlot({
      state: "working",
      lastHeartbeat: Date.now() - ENGINEER_MAX_IDLE - 1000,
    }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results).toHaveLength(1)
    expect(results[0].isStuck).toBe(true)
    expect(results[0].stuckCount).toBe(1)
    expect(results[0].isDead).toBe(false)
  })

  test("checkHealth marks engineer dead after 3 stuck cycles", async () => {
    engineers.set(ENG_A, makeSlot({
      state: "working",
      lastHeartbeat: Date.now() - ENGINEER_MAX_IDLE - 1000,
    }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    // Pre-seed stuckCount=2 in the in-memory health record; the next
    // checkHealth tick should bump to 3 (dead).
    // Some implementations create the health entry lazily on first
    // checkHealth — ensure a record exists by recording a heartbeat first.
    await runWith(service.recordHeartbeat(ENG_A))
    const h2 = service.getHealth(ENG_A)!
    h2.stuckCount = 2

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results[0].isStuck).toBe(true)
    expect(results[0].stuckCount).toBe(3)
    expect(results[0].isDead).toBe(true)
  })

  test("checkHealth does not mark completed idle engineers stuck after heartbeat ages out", async () => {
    engineers.set(ENG_A, makeSlot({
      state: "idle",
      currentTask: null,
      lastHeartbeat: Date.now() - ENGINEER_MAX_IDLE - 1000,
    }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))
    const health = service.getHealth(ENG_A)!
    health.stuckCount = 2
    health.isStuck = true
    health.isDead = true

    const results = await runWith(service.checkHealth(TEAM_ID))

    expect(results).toHaveLength(1)
    expect(results[0].isStuck).toBe(false)
    expect(results[0].stuckCount).toBe(0)
    expect(results[0].isDead).toBe(false)
    expect(killEngineerCalls).toHaveLength(0)
  })

  test("runDiagnostic does not kill an idle engineer even if stale health was marked dead", async () => {
    engineers.set(ENG_A, makeSlot({
      state: "idle",
      currentTask: null,
      lastHeartbeat: Date.now() - ENGINEER_MAX_IDLE - 1000,
    }))
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

    expect(result.action).toBe("healthy")
    expect(engineers.has(ENG_A)).toBe(true)
    expect(killEngineerCalls).toHaveLength(0)
    expect([...mailboxMessages.values()].some((m) => m.type === "all-engineers-failed")).toBe(false)
  })

  test("runDiagnostic kills dead engineer and reassigns task", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as TaskBoardID, state: "working" }))
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
    expect(killEngineerCalls[0]?.failureReason).toBe("heartbeat-dead")
  })

  test("runDiagnostic skips kill when daemon already owns termination", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as TaskBoardID, state: "working" }))
    teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))
    markTerminating(TEAM_ID, ENG_A)

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.recordHeartbeat(ENG_A))

    const health = service.getHealth(ENG_A)!
    health.isDead = true
    health.isStuck = true
    health.stuckCount = 3

    const result = await runWith(service.runDiagnostic(ENG_A, TEAM_ID))

    expect(result.action).toBe("killed")
    expect(killEngineerCalls).toHaveLength(0)
    expect(engineers.has(ENG_A)).toBe(true)
  })

  test("runDiagnostic sends all-failed message when no engineers remain", async () => {
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as TaskBoardID, state: "working" }))
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
    engineers.set(ENG_A, makeSlot({ currentTask: "task_1" as TaskBoardID, state: "working" }))
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
    expect(killEngineerCalls.map((call) => call.failureReason)).toEqual(["lead-orphaned", "lead-orphaned"])
  })

  test("detectOrphans skips engineers already terminating", async () => {
    teams.set(TEAM_ID, makeTeam())
    engineers.set(ENG_A, makeSlot())
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, sessionID: "sess_eng_b" as SessionID, name: "engineer-b" }))
    markTerminating(TEAM_ID, ENG_A)

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    teams.delete(TEAM_ID)

    const result = await runWith(service.detectOrphans(TEAM_ID, LEAD_SESSION))

    expect(result.leadAlive).toBe(false)
    expect(result.engineersTerminated).toEqual([ENG_B])
    expect(killEngineerCalls).toEqual([{ engineerID: ENG_B, teamID: TEAM_ID, failureReason: "lead-orphaned" }])
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

  // ─── startTeamMonitoring / stopTeamMonitoring ────────────────────────────

  test("startTeamMonitoring is idempotent: second call is a no-op", async () => {
    teams.set(TEAM_ID, makeTeam())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    // Call twice — should not throw and should tear down cleanly once
    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))
    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))

    // Single stop should succeed without error
    await runWith(service.stopTeamMonitoring(TEAM_ID))

    // After stop, no health entries remain (team had no engineers)
    expect(service.getHealth(ENG_A)).toBeNull()
  })

  test("stopTeamMonitoring cleans health entries for team engineers", async () => {
    teams.set(TEAM_ID, makeTeam({ engineerCount: 1 }))
    engineers.set(ENG_A, makeSlot())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))
    // Seed a health entry so we can verify it gets cleared
    await runWith(service.recordHeartbeat(ENG_A))
    expect(service.getHealth(ENG_A)).not.toBeNull()

    await runWith(service.stopTeamMonitoring(TEAM_ID))

    expect(service.getHealth(ENG_A)).toBeNull()
  })

  test("multi-team isolation: stopping team1 does not affect team2", async () => {
    const TEAM_2 = "team_two" as TeamID
    const LEAD_2 = "sess_lead_two" as SessionID
    teams.set(TEAM_ID, makeTeam())
    teams.set(TEAM_2, makeTeam({ teamID: TEAM_2, leadSessionID: LEAD_2 }))
    engineers.set(ENG_A, makeSlot({ teamID: TEAM_ID }))
    engineers.set(ENG_B, makeSlot({ engineerID: ENG_B, teamID: TEAM_2, sessionID: "sess_eng_b" as SessionID, name: "engineer-b" }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))
    await runWith(service.startTeamMonitoring(TEAM_2, LEAD_2))

    await runWith(service.recordHeartbeat(ENG_A))
    await runWith(service.recordHeartbeat(ENG_B))

    // Stop team1; team2's engineer health should remain
    await runWith(service.stopTeamMonitoring(TEAM_ID))

    expect(service.getHealth(ENG_A)).toBeNull()
    expect(service.getHealth(ENG_B)).not.toBeNull()

    // Clean up team2
    await runWith(service.stopTeamMonitoring(TEAM_2))
  })

  test("stopTeamMonitoring on never-started team is a no-op", async () => {
    const UNKNOWN_TEAM = "team_never_started" as TeamID

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    // Must not throw
    await expect(
      runWith(service.stopTeamMonitoring(UNKNOWN_TEAM)),
    ).resolves.toBeUndefined()
  })

  // ─── isMonitoring / primary+backstop gate ───────────────────────────────

  test("isMonitoring returns true while team monitoring is active", async () => {
    teams.set(TEAM_ID, makeTeam())

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    // Before start: not monitored — daemon backstop should handle it
    const before = await runWith(service.isMonitoring(TEAM_ID))
    expect(before).toBe(false)

    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))

    // After start: primary monitor is active — daemon should skip
    const during = await runWith(service.isMonitoring(TEAM_ID))
    expect(during).toBe(true)

    await runWith(service.stopTeamMonitoring(TEAM_ID))

    // After stop: falls back to daemon backstop again
    const after = await runWith(service.isMonitoring(TEAM_ID))
    expect(after).toBe(false)
  })

  test("isMonitoring is per-team: one team active does not affect another", async () => {
    const TEAM_2 = "team_other" as TeamID
    const LEAD_2 = "sess_lead_other" as SessionID
    teams.set(TEAM_ID, makeTeam())
    teams.set(TEAM_2, makeTeam({ teamID: TEAM_2, leadSessionID: LEAD_2 }))

    const service = await runWith(Effect.gen(function* () {
      return yield* HeartbeatService
    }))

    await runWith(service.startTeamMonitoring(TEAM_ID, LEAD_SESSION))

    // TEAM_ID is monitored
    expect(await runWith(service.isMonitoring(TEAM_ID))).toBe(true)
    // TEAM_2 is NOT monitored — still available for daemon backstop
    expect(await runWith(service.isMonitoring(TEAM_2))).toBe(false)

    await runWith(service.startTeamMonitoring(TEAM_2, LEAD_2))

    // Both monitored now
    expect(await runWith(service.isMonitoring(TEAM_ID))).toBe(true)
    expect(await runWith(service.isMonitoring(TEAM_2))).toBe(true)

    await runWith(service.stopTeamMonitoring(TEAM_ID))

    // Only TEAM_2 still monitored
    expect(await runWith(service.isMonitoring(TEAM_ID))).toBe(false)
    expect(await runWith(service.isMonitoring(TEAM_2))).toBe(true)

    await runWith(service.stopTeamMonitoring(TEAM_2))
  })
})
