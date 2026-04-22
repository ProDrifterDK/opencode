import { Effect, Layer, Context, Schema, Schedule, Scope } from "effect"
import { Service as SessionCoordinatorService, type EngineerSlot } from "./session-coordinator"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as MailboxService } from "./mailbox"
import { HEARTBEAT_INTERVAL, ENGINEER_MAX_IDLE } from "./constants"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "../session/schema"

export class HeartbeatError extends Schema.TaggedErrorClass<HeartbeatError>()("HeartbeatError", {
  message: Schema.String,
}) {}

export class RateLimitError extends Schema.TaggedErrorClass<RateLimitError>()("RateLimitError", {
  engineerID: Schema.String,
  retryAfterMs: Schema.Number,
}) {}

export class AllEngineersFailedError extends Schema.TaggedErrorClass<AllEngineersFailedError>()("AllEngineersFailedError", {
  teamID: Schema.String,
  failedCount: Schema.Number,
}) {}

export interface EngineerHealth {
  engineerID: EngineerID
  lastHeartbeat: number
  stuckCount: number
  backoffUntil: number | null
  isStuck: boolean
  isDead: boolean
}

export interface DiagnosticResult {
  engineerID: EngineerID
  pingSucceeded: boolean
  action: "healthy" | "reassigned" | "killed" | "all-failed"
  taskReassignedTo: EngineerID | null
  timestamp: number
}

export interface OrphanStatus {
  teamID: TeamID
  leadAlive: boolean
  engineersTerminated: EngineerID[]
  timestamp: number
}

export interface Interface {
  readonly startMonitoring: (teamID: TeamID, leadSessionID: SessionID) => Effect.Effect<void, never, Scope.Scope>
  readonly stopMonitoring: (teamID: TeamID) => Effect.Effect<void>
  readonly recordHeartbeat: (engineerID: EngineerID) => Effect.Effect<void, HeartbeatError>
  readonly checkHealth: (teamID: TeamID) => Effect.Effect<EngineerHealth[], HeartbeatError>
  readonly runDiagnostic: (engineerID: EngineerID, teamID: TeamID) => Effect.Effect<DiagnosticResult, HeartbeatError>
  readonly handleRateLimit: (engineerID: EngineerID) => Effect.Effect<void>
  readonly handleCrash: (engineerID: EngineerID, teamID: TeamID) => Effect.Effect<DiagnosticResult, HeartbeatError>
  readonly detectOrphans: (teamID: TeamID, leadSessionID: SessionID) => Effect.Effect<OrphanStatus, HeartbeatError>
  readonly getHealth: (engineerID: EngineerID) => EngineerHealth | null
}

const DIAGNOSTIC_PING_TIMEOUT_MS = 10_000
const MAX_BACKOFF_MS = 5 * 60 * 1000
const BASE_BACKOFF_MS = 30_000
const RATE_LIMIT_THRESHOLD = 3
const ORPHAN_CHECK_INTERVAL_MS = 60_000

export class Service extends Context.Service<Service, Interface>()("@opencode/HeartbeatMonitor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinatorService
    const lead = yield* LeadCoordinatorService
    const mailbox = yield* MailboxService

    const healthMap = new Map<EngineerID, EngineerHealth>()
    const monitoringFibers = new Map<TeamID, unknown>()
    const leadAliveMap = new Map<TeamID, { sessionID: SessionID; lastSeen: number }>()
    const rateLimitCounts = new Map<EngineerID, number>()
    const rateLimitBackoff = new Map<EngineerID, number>()

    const getOrCreateHealth = (engineerID: EngineerID): EngineerHealth => {
      const existing = healthMap.get(engineerID)
      if (existing) return existing
      const health: EngineerHealth = {
        engineerID,
        lastHeartbeat: Date.now(),
        stuckCount: 0,
        backoffUntil: null,
        isStuck: false,
        isDead: false,
      }
      healthMap.set(engineerID, health)
      return health
    }

    const recordHeartbeat = Effect.fn("HeartbeatMonitor.recordHeartbeat")(
      function* (engineerID: EngineerID) {
        const health = getOrCreateHealth(engineerID)
        const now = Date.now()

        health.lastHeartbeat = now
        health.isStuck = false
        health.isDead = false
        health.stuckCount = 0

        rateLimitCounts.delete(engineerID)
        rateLimitBackoff.delete(engineerID)
        health.backoffUntil = null
      },
    )

    const checkHealth = Effect.fn("HeartbeatMonitor.checkHealth")(
      function* (teamID: TeamID) {
        const engineers = yield* coordinator.listTeamEngineers(teamID).pipe(
          Effect.orElseSucceed(() => [] as EngineerSlot[]),
        )
        const now = Date.now()

        const results: EngineerHealth[] = []

        for (const eng of engineers) {
          const health = getOrCreateHealth(eng.engineerID)
          const idleMs = now - health.lastHeartbeat

          if (health.backoffUntil && now < health.backoffUntil) {
            results.push(health)
            continue
          }

          if (idleMs > ENGINEER_MAX_IDLE) {
            health.isStuck = true
            health.stuckCount++
            health.isDead = health.stuckCount >= 3
          }

          results.push(health)
        }

        return results
      },
    )

    const runDiagnostic = Effect.fn("HeartbeatMonitor.runDiagnostic")(
      function* (engineerID: EngineerID, teamID: TeamID) {
        const health = getOrCreateHealth(engineerID)
        const now = Date.now()

        if (health.isDead) {
          const slot = yield* coordinator.getEngineer(engineerID).pipe(
            Effect.orElseSucceed(() => null),
          )
          const currentTask = slot?.currentTask

          yield* coordinator.killEngineer({ engineerID, teamID }).pipe(
            Effect.catchCause(() => Effect.void),
          )

          healthMap.delete(engineerID)

          if (currentTask) {
            const teamEngineers = yield* coordinator.listTeamEngineers(teamID).pipe(
              Effect.orElseSucceed(() => [] as EngineerSlot[]),
            )
            const available = teamEngineers.find(
              (e) => e.engineerID !== engineerID && e.state === "idle",
            )

            if (available) {
              yield* lead.reassign({
                taskId: currentTask as any,
                toEngineer: available.engineerID,
              }).pipe(
                Effect.catchCause(() => Effect.void),
              )

              const result: DiagnosticResult = {
                engineerID,
                pingSucceeded: false,
                action: "reassigned",
                taskReassignedTo: available.engineerID,
                timestamp: now,
              }
              return result
            }
          }

          const remaining = yield* coordinator.listTeamEngineers(teamID).pipe(
            Effect.orElseSucceed(() => [] as EngineerSlot[]),
          )
          if (remaining.length === 0) {
        const team = yield* coordinator.getTeam(teamID).pipe(
          Effect.orElseSucceed(() => null),
        )
            if (team) {
              yield* mailbox.send({
                recipientSessionID: team.leadSessionID,
                senderSessionID: "system" as SessionID,
                priority: "urgent",
                type: "all-engineers-failed",
                content: `All engineers in team ${teamID} have failed. No available engineers for reassignment.`,
              }).pipe(Effect.catchCause(() => Effect.void))
            }

            const result: DiagnosticResult = {
              engineerID,
              pingSucceeded: false,
              action: "all-failed",
              taskReassignedTo: null,
              timestamp: now,
            }
            return result
          }

          const result: DiagnosticResult = {
            engineerID,
            pingSucceeded: false,
            action: "killed",
            taskReassignedTo: null,
            timestamp: now,
          }
          return result
        }

        const slot = yield* coordinator.getEngineer(engineerID).pipe(
          Effect.orElseSucceed(() => null),
        )
        if (!slot) {
          const result: DiagnosticResult = {
            engineerID,
            pingSucceeded: false,
            action: "killed",
            taskReassignedTo: null,
            timestamp: now,
          }
          return result
        }

        const pingResponse = yield* mailbox.hasUnread({
          recipientSessionID: slot.sessionID,
          priority: "urgent",
        }).pipe(
          Effect.timeout(DIAGNOSTIC_PING_TIMEOUT_MS),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (pingResponse) {
          health.lastHeartbeat = now
          health.isStuck = false
          health.stuckCount = Math.max(0, health.stuckCount - 1)

          const result: DiagnosticResult = {
            engineerID,
            pingSucceeded: true,
            action: "healthy",
            taskReassignedTo: null,
            timestamp: now,
          }
          return result
        }

        const result: DiagnosticResult = {
          engineerID,
          pingSucceeded: false,
          action: health.stuckCount >= 2 ? "reassigned" : "healthy",
          taskReassignedTo: null,
          timestamp: now,
        }
        return result
      },
    )

    const handleRateLimit = Effect.fn("HeartbeatMonitor.handleRateLimit")(
      function* (engineerID: EngineerID) {
        const count = (rateLimitCounts.get(engineerID) ?? 0) + 1
        rateLimitCounts.set(engineerID, count)

        const health = getOrCreateHealth(engineerID)

        if (count >= RATE_LIMIT_THRESHOLD) {
          health.backoffUntil = Date.now() + MAX_BACKOFF_MS
          rateLimitBackoff.set(engineerID, MAX_BACKOFF_MS)
        } else {
          const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, count - 1), MAX_BACKOFF_MS)
          health.backoffUntil = Date.now() + backoff
          rateLimitBackoff.set(engineerID, backoff)
        }
      },
    )

    const handleCrash = Effect.fn("HeartbeatMonitor.handleCrash")(
      function* (engineerID: EngineerID, teamID: TeamID) {
        const health = getOrCreateHealth(engineerID)
        health.isDead = true
        health.isStuck = true

        return yield* runDiagnostic(engineerID, teamID)
      },
    )

    const detectOrphans = Effect.fn("HeartbeatMonitor.detectOrphans")(
      function* (teamID: TeamID, leadSessionID: SessionID) {
        const now = Date.now()

        const team = yield* coordinator.getTeam(teamID).pipe(
          Effect.orElseSucceed(() => null),
        )
        const leadAlive = team !== null && team.state !== "dissolving"

        if (leadAlive) {
          leadAliveMap.set(teamID, { sessionID: leadSessionID, lastSeen: now })

          const result: OrphanStatus = {
            teamID,
            leadAlive: true,
            engineersTerminated: [],
            timestamp: now,
          }
          return result
        }

        const engineers = yield* coordinator.listTeamEngineers(teamID).pipe(
          Effect.orElseSucceed(() => [] as EngineerSlot[]),
        )
        const terminated: EngineerID[] = []

        for (const eng of engineers) {
          yield* coordinator.killEngineer({ engineerID: eng.engineerID, teamID }).pipe(
            Effect.catchCause(() => Effect.void),
          )
          healthMap.delete(eng.engineerID)
          terminated.push(eng.engineerID)
        }

        leadAliveMap.delete(teamID)
        monitoringFibers.delete(teamID)

        const result: OrphanStatus = {
          teamID,
          leadAlive: false,
          engineersTerminated: terminated,
          timestamp: now,
        }
        return result
      },
    )

    const startMonitoring = Effect.fn("HeartbeatMonitor.startMonitoring")(
      function* (teamID: TeamID, leadSessionID: SessionID) {
        leadAliveMap.set(teamID, { sessionID: leadSessionID, lastSeen: Date.now() })

        const heartbeatLoop = Effect.gen(function* () {
          const healthResults = yield* checkHealth(teamID)

          for (const health of healthResults) {
            if (health.isStuck) {
              yield* runDiagnostic(health.engineerID, teamID).pipe(
                Effect.catchCause(() => Effect.void),
              )
            }
          }
        })

        const orphanLoop = Effect.gen(function* () {
          yield* detectOrphans(teamID, leadSessionID).pipe(
            Effect.catchCause(() => Effect.void),
          )
        })

        yield* Effect.forkScoped(
          heartbeatLoop.pipe(
            Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)),
          ),
        )

        yield* Effect.forkScoped(
          orphanLoop.pipe(
            Effect.repeat(Schedule.spaced(ORPHAN_CHECK_INTERVAL_MS)),
          ),
        )
      },
    )

    const stopMonitoring = Effect.fn("HeartbeatMonitor.stopMonitoring")(
      function* (teamID: TeamID) {
        leadAliveMap.delete(teamID)
        monitoringFibers.delete(teamID)

        const engineers = yield* coordinator.listTeamEngineers(teamID).pipe(
          Effect.catchCause(() => Effect.succeed([] as EngineerSlot[])),
        )
        for (const eng of engineers) {
          healthMap.delete(eng.engineerID)
        }
      },
    )

    const getHealth = (engineerID: EngineerID): EngineerHealth | null =>
      healthMap.get(engineerID) ?? null

    return Service.of({
      startMonitoring,
      stopMonitoring,
      recordHeartbeat,
      checkHealth,
      runDiagnostic,
      handleRateLimit,
      handleCrash,
      detectOrphans,
      getHealth,
    })
  }),
)

export * as HeartbeatMonitor from "./heartbeat"
