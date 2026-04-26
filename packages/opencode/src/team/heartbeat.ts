import { Effect, Layer, Context, Schema, Schedule, Scope, Exit } from "effect"
import { Service as SessionCoordinatorService, type EngineerSlot } from "./session-coordinator"
import { Service as LeadCoordinatorService } from "./lead-coordinator"
import { Service as MailboxService } from "./mailbox"
import { HEARTBEAT_INTERVAL, ENGINEER_MAX_IDLE, HEARTBEAT_UPDATE_INTERVAL, HEARTBEAT_CHECK_INTERVAL, HEARTBEAT_TIMEOUT } from "./constants"
import { iterAllRunning } from "./daemon-running"
import { Log } from "@/util"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "../session/schema"

const log = Log.create({ service: "team.heartbeat" })

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
  readonly startTeamMonitoring: (teamID: TeamID, leadSessionID: SessionID) => Effect.Effect<void>
  readonly stopTeamMonitoring: (teamID: TeamID) => Effect.Effect<void>
  readonly isMonitoring: (teamID: TeamID) => Effect.Effect<boolean>
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
          // If the team is in a teardown state, the lead is already
          // taking the engineers down. Calling killEngineer here would
          // emit a spurious `EngineerFailed` with `error: "killed by
          // coordinator"` for engineers that may have completed cleanly
          // via team_report — and the subsequent listTeamEngineers
          // could see an empty roster mid-transaction and fire a false
          // "all-engineers-failed" mailbox urgent. Skip both during
          // dissolve/terminated.
          const teamForGate = yield* coordinator.getTeam(teamID).pipe(
            Effect.orElseSucceed(() => null),
          )
          if (teamForGate && teamForGate.state !== "active") {
            healthMap.delete(engineerID)
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
          const currentTask = slot?.currentTask

          log.warn("heartbeat runDiagnostic killing engineer (isDead)", {
            engineerID,
            teamID,
            stuckCount: health.stuckCount,
          })
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

          // Only count engineers that are still alive and could pick up
          // work. The `liveOnly` filter (in session-coordinator.ts)
          // excludes only `failed` engineers — `idle`, `working`, and
          // `blocked` all count as alive. Idle is alive because:
          //   - just-spawned engineers are idle until they pick a task
          //   - just-completed engineers are idle after team_report
          // and in both cases the subprocess is still around to pick
          // up reassigned work. The earlier semantics (idle excluded)
          // produced spurious `all-engineers-failed` urgents when one
          // engineer died while siblings were still in their post-spawn
          // idle window.
          const remaining = yield* coordinator.listTeamEngineers(teamID, { liveOnly: true }).pipe(
            Effect.orElseSucceed(() => [] as EngineerSlot[]),
          )
          if (remaining.length === 0) {
            const team = yield* coordinator.getTeam(teamID).pipe(
              Effect.orElseSucceed(() => null),
            )
            // Only fire the urgent mailbox when the team is NOT in a
            // teardown state. During dissolve/terminated the lead is
            // already tearing things down; the urgent message would be
            // spurious. Note: killEngineer transitions the team to
            // "idle" when the last engineer slot is removed, so we
            // cannot check for "active" here — we check for the
            // absence of the two teardown states instead.
            if (team && team.state !== "dissolving" && team.state !== "terminated") {
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

        log.warn("detectOrphans killing all engineers (lead dead)", {
          teamID,
          engineerCount: engineers.length,
        })
        for (const eng of engineers) {
          log.warn("detectOrphans killing engineer", { engineerID: eng.engineerID, teamID })
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

        // Primary: write alive timestamps for all running engineers in this team
        const updateHeartbeatsLoop = Effect.gen(function* () {
          for (const [tid, , eng] of iterAllRunning()) {
            if (tid !== teamID) continue
            yield* coordinator
              .updateEngineer(eng.engineerID as EngineerID, {})
              .pipe(Effect.catchCause(() => Effect.void))
          }
        })

        // Primary: mark unresponsive engineers stale / terminate them
        const checkStaleLoop = Effect.gen(function* () {
          const now = Date.now()
          const teamEngineers = yield* coordinator.listTeamEngineers(teamID).pipe(
            Effect.orElseSucceed(() => [] as EngineerSlot[]),
          )
          for (const engineer of teamEngineers) {
            if (engineer.state !== "working") continue
            const timeSinceHeartbeat = now - engineer.lastHeartbeat
            if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT) {
              const health = getOrCreateHealth(engineer.engineerID)
              health.isStuck = true
              health.stuckCount++
              health.isDead = health.stuckCount >= 3
              yield* runDiagnostic(engineer.engineerID, teamID).pipe(
                Effect.catchCause(() => Effect.void),
              )
            }
          }
        })

        const heartbeatCheckLoop = Effect.gen(function* () {
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

        // Every HEARTBEAT_UPDATE_INTERVAL: refresh alive timestamps (primary)
        yield* Effect.forkScoped(
          updateHeartbeatsLoop.pipe(
            Effect.repeat(Schedule.spaced(HEARTBEAT_UPDATE_INTERVAL)),
          ),
        )

        // Every HEARTBEAT_CHECK_INTERVAL: terminate stale engineers (primary)
        yield* Effect.forkScoped(
          checkStaleLoop.pipe(
            Effect.repeat(Schedule.spaced(HEARTBEAT_CHECK_INTERVAL)),
          ),
        )

        yield* Effect.forkScoped(
          heartbeatCheckLoop.pipe(
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

    // Per-team scope registry. The scope must outlive `startMonitoring`'s
    // effect so its `Effect.forkScoped` fibers stay alive. We close it on
    // `stopTeamMonitoring` to interrupt those fibers.
    const monitoringScopes = new Map<TeamID, Scope.Closeable>()

    /** Returns true if a HeartbeatMonitor scope is active for this team. */
    const isMonitoring = (teamID: TeamID): Effect.Effect<boolean> =>
      Effect.sync(() => monitoringScopes.has(teamID))

    const startTeamMonitoring = Effect.fn("HeartbeatMonitor.startTeamMonitoring")(
      function* (teamID: TeamID, leadSessionID: SessionID) {
        if (monitoringScopes.has(teamID)) return
        const scope = yield* Scope.make()
        monitoringScopes.set(teamID, scope)
        yield* startMonitoring(teamID, leadSessionID).pipe(Scope.provide(scope))
      },
    )

    const stopTeamMonitoring = Effect.fn("HeartbeatMonitor.stopTeamMonitoring")(
      function* (teamID: TeamID) {
        const scope = monitoringScopes.get(teamID)
        if (!scope) return
        monitoringScopes.delete(teamID)
        yield* stopMonitoring(teamID)
        yield* Scope.close(scope, Exit.void)
      },
    )

    const getHealth = (engineerID: EngineerID): EngineerHealth | null =>
      healthMap.get(engineerID) ?? null

    return Service.of({
      startMonitoring,
      stopMonitoring,
      startTeamMonitoring,
      stopTeamMonitoring,
      isMonitoring,
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
