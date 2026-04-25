import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { Log } from "@/util"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Event, publishTeamEvent } from "./events"
import { SessionCoordinator, type EngineerSlot } from "./session-coordinator"
import { AppRuntime } from "@/effect/app-runtime"
import { Mailbox, Event as MailboxEvent } from "./mailbox"
import { TaskBoardRepo } from "./task-board"
import { Database } from "@/storage"
import { EngineerSlotTable, TeamStateTable } from "./session-coordinator.sql"
import { TaskBoardTable } from "./task-board.sql"
import { eq } from "drizzle-orm"
import { Event as MessageEvent } from "@/session/message-v2"
import { ENGINEER_MAX_RUNTIME, HEARTBEAT_UPDATE_INTERVAL, HEARTBEAT_CHECK_INTERVAL, HEARTBEAT_TIMEOUT } from "./constants"
import { RateLimiter } from "./rate-limiter"
import { Service as HeartbeatMonitorService, layer as heartbeatLayer } from "./heartbeat"
import { LeadCoordinator } from "./lead-coordinator"
import { GitManager } from "./git-manager"
import {
  Service as EngineerProcessManager,
  layer as engineerProcessManagerLayer,
} from "./engineer-process-manager"
import type { EngineerID, TeamID } from "./types"
import type { TaskBoardID } from "./task-board.sql"
import {
  type RunningEngineer,
  running,
  setRunning,
  getRunningEngineer,
  deleteRunning,
  iterAllRunning,
  countAllRunning,
} from "./daemon-running"

const log = Log.create({ service: "team.daemon" })

// Best-effort SIGTERM on an engineer subprocess. Errors are logged but
// never thrown — losing visibility into a kill failure is acceptable
// (Phase 3 will add `.exited` confirmation). Lives outside Effect.gen
// so callers don't need try/catch inside generators.
const killEngineerSubprocess = (engineerID: string, pid: number, sub: import("bun").Subprocess | undefined): void => {
  if (!sub) return
  try {
    sub.kill()
  } catch (err) {
    log.warn("subprocess.kill() failed", { engineerID, pid, error: String(err) })
  }
}

// Heartbeat constants are defined in ./constants and imported above.
// The daemon's setInterval sweep acts as a backstop for teams that
// HeartbeatMonitor is not actively watching. For teams with an active
// HeartbeatMonitor scope the sweep is skipped (isMonitoring returns true).

interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly getRunning: () => Effect.Effect<RunningEngineer[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamDaemon") {}

let heartbeatUpdateInterval: ReturnType<typeof setInterval> | null = null
let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null
let sigintHandlerRegistered = false

/**
 * Graceful shutdown - called on SIGINT to clean up database state.
 * This runs synchronously outside the Effect runtime.
 */
export function gracefulShutdown(): void {
  log.info("graceful shutdown initiated", { runningEngineers: countAllRunning() })

  if (heartbeatUpdateInterval) {
    clearInterval(heartbeatUpdateInterval)
    heartbeatUpdateInterval = null
  }
  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval)
    heartbeatCheckInterval = null
  }

  // Mark all working engineers as terminated and their tasks as pending
  try {
    Database.use((db) => {
      const now = Date.now()

      // Get all working engineers
      const workingEngineers = db
        .select()
        .from(EngineerSlotTable)
        .where(eq(EngineerSlotTable.state, "working"))
        .all()

      for (const engineer of workingEngineers) {
        // Mark engineer as terminated
        db.update(EngineerSlotTable)
          .set({
            state: "failed",
            current_task: null,
            time_updated: now,
          })
          .where(eq(EngineerSlotTable.id, engineer.id))
          .run()

        log.info("marked engineer as terminated", { engineerID: engineer.id })

        // Release their task back to pending
        if (engineer.current_task) {
          db.update(TaskBoardTable)
            .set({
              status: "pending",
              assigned_engineer_id: null,
              time_updated: now,
            })
            .where(eq(TaskBoardTable.id, engineer.current_task as TaskBoardID))
            .run()

          log.info("released task to pending", { taskID: engineer.current_task })
        }
      }

      // Mark all active teams as terminated (abrupt shutdown, distinct from
      // user-initiated "dissolving"). "terminated" is a valid TeamState; prior
      // code wrote "completed" which was NOT in the enum and caused downstream
      // validation to misbehave.
      db.update(TeamStateTable)
        .set({
          state: "terminated",
          time_updated: now,
        })
        .where(eq(TeamStateTable.state, "active"))
        .run()

      log.info("graceful shutdown complete", { terminatedEngineers: workingEngineers.length })
    })
  } catch (err) {
    log.error("graceful shutdown failed", { error: String(err) })
  }

  // Clear running map
  running.clear()
}

// Engineer loop body lives in `./engineer-loop.ts`. It is no longer
// invoked in-process here; instead, the lead spawns a subprocess via
// `EngineerProcessManager.spawn` (Phase 1 of A3) and the new
// `team-engineer-run` CLI subcommand calls `runEngineerLoop` inside
// the child. Process isolation means a crashing engineer can't take
// the lead with it.

const startEngineerInBackground = (input: {
  teamID: string
  engineerID: string
  sessionID: SessionID
  name: string
  taskId: string
  taskTitle: string
  taskDescription: string
  providerID?: string
  modelID?: string
  teammates?: Array<{ name: string; engineerID: string; task?: string }>
}) =>
  Effect.gen(function* () {
    const gitManager = yield* GitManager.Service
    const processManager = yield* EngineerProcessManager

    log.info("creating worktree for engineer", {
      engineerID: input.engineerID,
      teamID: input.teamID,
    })

    const { worktreePath, branch } = yield* gitManager.createEngineerWorktree({
      teamID: input.teamID as TeamID,
      engineerID: input.engineerID as EngineerID,
    })

    log.info("spawning engineer subprocess", {
      engineerID: input.engineerID,
      worktreePath,
      branch,
      model: input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : "(default)",
    })

    const spawned = yield* processManager.spawn({
      teamID: input.teamID as TeamID,
      engineerID: input.engineerID as EngineerID,
      sessionID: input.sessionID,
      worktreePath,
      taskID: input.taskId,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription,
      name: input.name,
      providerID: input.providerID,
      modelID: input.modelID,
    })

    setRunning(input.teamID as TeamID, input.engineerID as EngineerID, {
      engineerID: input.engineerID,
      sessionID: input.sessionID,
      teamID: input.teamID,
      startedAt: Date.now(),
      worktreePath,
      branch,
      pid: spawned.pid,
      subprocess: spawned.subprocess,
    })

    log.info("engineer subprocess registered", {
      engineerID: input.engineerID,
      pid: spawned.pid,
      running: countAllRunning(),
    })
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const coordinator = yield* SessionCoordinator.Service
    const promptService = yield* SessionPrompt.Service
    const mailbox = yield* Mailbox.Service
    const taskBoard = yield* TaskBoardRepo.Service
    const heartbeatMonitor = yield* HeartbeatMonitorService

    let unsubscribers: Array<() => void> = []

    // Update heartbeats for all running engineers so stale-detection
    // doesn't misfire on a healthy but quiet fiber. Best-effort: a
    // failed update is logged but never thrown.
    // Backstop only: skips teams already covered by HeartbeatMonitor.
    const updateRunningHeartbeats = () => {
      if (running.size === 0) return

      AppRuntime.runFork(Effect.gen(function* () {
        for (const [teamID, engineerID] of iterAllRunning()) {
          const monitored = yield* heartbeatMonitor.isMonitoring(teamID)
          if (monitored) continue
          yield* coordinator
            .updateEngineer(engineerID as EngineerID, {})
            .pipe(Effect.catchCause(() => Effect.void))
        }
      }))
    }

    const terminateEngineer = (
      engineer: EngineerSlot,
      reason: string,
      progressText: string,
    ) =>
      Effect.gen(function* () {
        log.warn("terminating engineer", { engineerID: engineer.engineerID, reason })

        // Release task back to pending so another engineer can claim it.
        if (engineer.currentTask) {
          yield* taskBoard.update(engineer.currentTask as TaskBoardID, {
            status: "pending",
            assigned_engineer_id: null,
          })
          log.info("released task", {
            engineerID: engineer.engineerID,
            taskID: engineer.currentTask,
          })
        }

        publishTeamEvent(Event.EngineerFailed, {
          teamID: engineer.teamID,
          engineerID: engineer.engineerID,
          taskId: engineer.currentTask ?? "unknown",
          error: reason,
        })
        publishTeamEvent(Event.EngineerProgress, {
          teamID: engineer.teamID,
          engineerID: engineer.engineerID,
          progressText,
          timestamp: Date.now(),
        })

        yield* coordinator.killEngineer({
          engineerID: engineer.engineerID,
          teamID: engineer.teamID,
        })

        const runningEngineer = getRunningEngineer(engineer.teamID as TeamID, engineer.engineerID as EngineerID)
        if (runningEngineer) {
          log.info("killing engineer subprocess", {
            engineerID: engineer.engineerID,
            pid: runningEngineer.pid,
          })
          // Phase 1: best-effort SIGTERM. Phase 3 will add an
          // `.exited` watcher so we can confirm the child actually
          // died and clean up regardless.
          killEngineerSubprocess(engineer.engineerID, runningEngineer.pid, runningEngineer.subprocess)
          deleteRunning(engineer.teamID as TeamID, engineer.engineerID as EngineerID)
        }
      })

    // Sweep for engineers whose heartbeat has gone silent or whose
    // total runtime has passed ENGINEER_MAX_RUNTIME, and terminate
    // them. Driven by the setInterval registered in `start()` below.
    // Backstop only: skips teams already covered by HeartbeatMonitor.
    const checkForStaleEngineers = () => {
      AppRuntime.runFork(Effect.gen(function* () {
        const now = Date.now()
        const allEngineers = yield* coordinator.listAllEngineers()

        for (const engineer of allEngineers) {
          if (engineer.state !== "working") continue

          // Skip engineers whose team has an active HeartbeatMonitor scope
          const monitored = yield* heartbeatMonitor.isMonitoring(engineer.teamID as TeamID)
          if (monitored) continue

          const timeSinceHeartbeat = now - engineer.lastHeartbeat
          if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT) {
            log.warn("engineer heartbeat timeout", {
              engineerID: engineer.engineerID,
              lastHeartbeat: new Date(engineer.lastHeartbeat).toISOString(),
              timeSinceHeartbeat: Math.round(timeSinceHeartbeat / 1000) + "s",
            })
            yield* terminateEngineer(
              engineer,
              "Heartbeat timeout - engineer unresponsive",
              "❌ Timeout: unresponsive",
            )
            continue
          }

          if (engineer.startedAt && now - engineer.startedAt > ENGINEER_MAX_RUNTIME) {
            const runtimeMin = Math.round((now - engineer.startedAt) / 60000)
            log.warn("engineer max runtime exceeded", {
              engineerID: engineer.engineerID,
              runtimeMin,
              limitMin: Math.round(ENGINEER_MAX_RUNTIME / 60000),
            })
            yield* terminateEngineer(
              engineer,
              `Max runtime exceeded (${runtimeMin} min)`,
              "❌ Max runtime exceeded",
            )
          }
        }
      }))
    }

    const handleLeadMessageReceived = (event: {
      type: string
      properties: {
        messageID: string
        recipientSessionID: string
        senderSessionID: string
        priority: "urgent" | "inbox" | "queue"
      }
    }) => {
      log.info("received lead message event", {
        recipientSessionID: event.properties.recipientSessionID,
        priority: event.properties.priority,
      })

      // Inject notification into lead's session
      const injectNotification = Effect.gen(function* () {
        // Fetch the message from mailbox
        const messages = yield* mailbox.receiveByPriority({
          recipientSessionID: event.properties.recipientSessionID as SessionID,
          priority: event.properties.priority,
        })

        if (messages.length === 0) {
          log.info("no messages found in mailbox")
          return
        }

        const msg = messages[0]
        yield* mailbox.markRead({
          messageID: msg.id,
          recipientSessionID: event.properties.recipientSessionID as SessionID,
        })

        const label = event.properties.priority === "urgent"
          ? "[URGENT MESSAGE FROM ENGINEER]"
          : event.properties.priority === "inbox"
            ? "[MESSAGE FROM ENGINEER]"
            : "[LOW PRIORITY MESSAGE]"

        const notificationText = `${label}\n${msg.content}\n\nRespond to acknowledge and take action.`

        log.info("injecting notification into lead session", {
          leadSessionID: event.properties.recipientSessionID,
          contentLength: notificationText.length,
        })

        // Inject as a new prompt to wake up the lead
        yield* promptService.prompt({
          sessionID: event.properties.recipientSessionID as SessionID,
          parts: [{ type: "text", text: notificationText }],
        })

        log.info("notification injected successfully")
      })

      // Run in background to not block the event handler
      AppRuntime.runFork(injectNotification)
    }

    // Single dispatcher for mailbox.message.received — checks recipient role
    // and forwards to the appropriate lead/engineer handler. Replaces the
    // duplicate EngineerMessageSent + LeadMessageReceived publishes that used
    // to fire for every send regardless of recipient role.
    const handleMailboxReceived = (event: {
      type: string
      properties: {
        messageID: string
        senderSessionID: string
        recipientSessionID: string
        priority: "urgent" | "inbox" | "queue"
      }
    }) => {
      AppRuntime.runFork(Effect.gen(function* () {
        const recipient = event.properties.recipientSessionID as SessionID
        const isLead = yield* coordinator.isLead(recipient)
        if (isLead) {
          handleLeadMessageReceived(event)
          return
        }
        const isEngineer = yield* coordinator.isEngineer(recipient)
        if (isEngineer) {
          handleEngineerMessageReceived(event)
          return
        }
        log.debug("mailbox message to unknown role, ignoring", {
          recipient,
          messageID: event.properties.messageID,
        })
      }))
    }

    const handleEngineerMessageReceived = (event: {
      type: string
      properties: {
        messageID: string
        senderSessionID: string
        recipientSessionID: string
        priority: "urgent" | "inbox" | "queue"
      }
    }) => {
      log.info("received engineer message event", {
        recipientSessionID: event.properties.recipientSessionID,
        senderSessionID: event.properties.senderSessionID,
        priority: event.properties.priority,
      })

      const injectNotification = Effect.gen(function* () {
        // Check if recipient is an engineer (not a lead)
        const isEngineer = yield* coordinator.isEngineer(event.properties.recipientSessionID as SessionID)
        if (!isEngineer) {
          log.info("recipient is not an engineer, skipping notification")
          return
        }

        // Get sender info for a better label
        const senderEngineer = yield* coordinator.getEngineerBySession(event.properties.senderSessionID as SessionID)
        const senderName = senderEngineer?.name ?? "teammate"

        // Fetch the message from mailbox
        const messages = yield* mailbox.receiveByPriority({
          recipientSessionID: event.properties.recipientSessionID as SessionID,
          priority: event.properties.priority,
        })

        if (messages.length === 0) {
          log.info("no messages found in mailbox for engineer")
          return
        }

        const msg = messages[0]
        yield* mailbox.markRead({
          messageID: msg.id,
          recipientSessionID: event.properties.recipientSessionID as SessionID,
        })

        const label = event.properties.priority === "urgent"
          ? `[URGENT MESSAGE FROM ${senderName.toUpperCase()}]`
          : `[MESSAGE FROM ${senderName}]`

        const notificationText = `${label}\n${msg.content}\n\nYou can reply using team_message.`

        log.info("injecting notification into engineer session", {
          recipientSessionID: event.properties.recipientSessionID,
          senderName,
          contentLength: notificationText.length,
        })

        yield* promptService.prompt({
          sessionID: event.properties.recipientSessionID as SessionID,
          parts: [{ type: "text", text: notificationText }],
        })

        log.info("engineer notification injected successfully")
      })

      AppRuntime.runFork(injectNotification)
    }

    const handleEngineerSpawned = (event: {
      type: string
      properties: {
        teamID: string
        engineerID: string
        sessionID: string
        name: string
        state: string
        taskID: string
        taskTitle: string
        taskDescription: string
        providerID?: string
        modelID?: string
      }
    }) => {
      log.info("received engineer.spawned event", {
        engineerID: event.properties.engineerID,
        model: event.properties.providerID && event.properties.modelID
          ? `${event.properties.providerID}/${event.properties.modelID}`
          : "(default)",
      })

      // Fetch teammates and start the engineer loop
      const startWithTeammates = Effect.gen(function* () {
        const teammates = yield* coordinator.listTeamEngineers(event.properties.teamID as unknown as TeamID)
        const otherEngineers = teammates
          .filter((e) => e.engineerID !== event.properties.engineerID)
          .map((e) => ({
            name: e.name,
            engineerID: e.engineerID,
            task: e.currentTask ?? undefined,
          }))

        yield* startEngineerInBackground({
          teamID: event.properties.teamID,
          engineerID: event.properties.engineerID,
          sessionID: event.properties.sessionID as SessionID,
          name: event.properties.name,
          taskId: event.properties.taskID,
          taskTitle: event.properties.taskTitle,
          taskDescription: event.properties.taskDescription,
          providerID: event.properties.providerID,
          modelID: event.properties.modelID,
          teammates: otherEngineers,
        })
      })

      AppRuntime.runFork(startWithTeammates.pipe(
        Effect.catch((err: unknown) =>
          Effect.gen(function* () {
            log.error("failed to start engineer loop", {
              engineerID: event.properties.engineerID,
              error: String(err),
            })
            // Emit a failure event so the Lead (and TUI) observe the abort
            // instead of the slot hanging in "working" forever.
            publishTeamEvent(Event.EngineerFailed, {
              teamID: event.properties.teamID,
              engineerID: event.properties.engineerID,
              taskId: event.properties.taskID,
              error: String(err),
            })
            publishTeamEvent(Event.EngineerProgress, {
              teamID: event.properties.teamID,
              engineerID: event.properties.engineerID,
              progressText: "❌ Failed to start (rate-limited or spawn error)",
              timestamp: Date.now(),
            })
            // Free the slot so the capacity cap doesn't leak. If this
            // itself fails we've done all we can; swallow and move on.
            yield* coordinator.killEngineer({
              engineerID: event.properties.engineerID as unknown as EngineerID,
              teamID: event.properties.teamID as unknown as TeamID,
            }).pipe(Effect.ignore)
            deleteRunning(event.properties.teamID as TeamID, event.properties.engineerID as EngineerID)
          }),
        ),
      ))
    }

    // Track last emitted tool per engineer to avoid duplicate progress updates
    const lastToolPerEngineer = new Map<string, string>()

    const handlePartUpdated = (event: {
      type: string
      properties: {
        sessionID: string
        part: {
          type: string
          tool?: string
          state?: { type: string }
        }
        time: number
      }
    }) => {
      // Only process tool parts that are running
      if (event.properties.part.type !== "tool") return
      if (event.properties.part.state?.type !== "running") return

      const toolName = event.properties.part.tool
      if (!toolName) return

      // Check if this session belongs to a running engineer
      let foundEngineerID: string | undefined
      let foundEngineer: RunningEngineer | undefined
      for (const [, eid, eng] of iterAllRunning()) {
        if (eng.sessionID === event.properties.sessionID) {
          foundEngineerID = eid
          foundEngineer = eng
          break
        }
      }
      if (!foundEngineerID || !foundEngineer) return

      const engineerID = foundEngineerID
      const engineer = foundEngineer

      // Skip if we already emitted this tool for this engineer
      const lastTool = lastToolPerEngineer.get(engineerID)
      if (lastTool === toolName) return
      lastToolPerEngineer.set(engineerID, toolName)

      // Format tool name for display (e.g., "Read" -> "Reading", "Bash" -> "Running bash")
      const formatToolName = (name: string) => {
        const lowerName = name.toLowerCase()
        if (lowerName === "read") return "Reading file"
        if (lowerName === "write") return "Writing file"
        if (lowerName === "edit") return "Editing file"
        if (lowerName === "bash") return "Running command"
        if (lowerName === "grep" || lowerName === "globalsearch") return "Searching"
        if (lowerName === "agent") return "Spawning agent"
        if (lowerName.startsWith("mcp__")) return `MCP: ${name.slice(5).split("__")[0]}`
        return name
      }

      publishTeamEvent(Event.EngineerProgress, {
        teamID: engineer.teamID,
        engineerID,
        progressText: formatToolName(toolName),
        timestamp: Date.now(),
      })
    }

    const start = Effect.fn("TeamDaemon.start")(function* () {
      log.info("starting team daemon")

      const unsubSpawned = yield* bus.subscribeCallback(Event.EngineerSpawned, handleEngineerSpawned)
      unsubscribers.push(unsubSpawned)

      const unsubMailbox = yield* bus.subscribeCallback(MailboxEvent.Received, handleMailboxReceived)
      unsubscribers.push(unsubMailbox)

      const unsubPartUpdated = yield* bus.subscribeCallback(MessageEvent.PartUpdated, handlePartUpdated)
      unsubscribers.push(unsubPartUpdated)

      heartbeatUpdateInterval = setInterval(updateRunningHeartbeats, HEARTBEAT_UPDATE_INTERVAL)
      heartbeatCheckInterval = setInterval(checkForStaleEngineers, HEARTBEAT_CHECK_INTERVAL)

      if (!sigintHandlerRegistered) {
        sigintHandlerRegistered = true
        process.on("SIGINT", () => {
          log.info("received SIGINT, initiating graceful shutdown")
          gracefulShutdown()
        })
        process.on("SIGTERM", () => {
          log.info("received SIGTERM, initiating graceful shutdown")
          gracefulShutdown()
        })
      }

      log.info("team daemon started, listening for events", {
        heartbeatUpdateInterval: HEARTBEAT_UPDATE_INTERVAL + "ms",
        heartbeatCheckInterval: HEARTBEAT_CHECK_INTERVAL + "ms",
        heartbeatTimeout: HEARTBEAT_TIMEOUT + "ms",
      })
    })

    const stop = Effect.fn("TeamDaemon.stop")(function* () {
      log.info("stopping team daemon")

      if (heartbeatUpdateInterval) {
        clearInterval(heartbeatUpdateInterval)
        heartbeatUpdateInterval = null
      }
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval)
        heartbeatCheckInterval = null
      }

      for (const unsub of unsubscribers) {
        unsub()
      }
      unsubscribers = []

      for (const [, engineerID, engineer] of iterAllRunning()) {
        log.info("killing engineer subprocess on daemon stop", {
          engineerID,
          pid: engineer.pid,
        })
        killEngineerSubprocess(engineerID as string, engineer.pid, engineer.subprocess)
      }
      running.clear()

      log.info("team daemon stopped")
    })

    const getRunning = Effect.fn("TeamDaemon.getRunning")(function* () {
      const result: RunningEngineer[] = []
      for (const [, , eng] of iterAllRunning()) result.push(eng)
      return result
    })

    // NOTE: Daemon is NOT auto-started. Call start() explicitly when needed
    // (e.g., from team_create). This prevents issues in CLI commands that
    // don't have instance context.

    // Clean up on shutdown (if start() was called)
    yield* Effect.addFinalizer(() => stop())

    return Service.of({ start, stop, getRunning })
  }),
)

const heartbeatDefaultLayer = heartbeatLayer.pipe(
  Layer.provide(SessionCoordinator.defaultLayer),
  Layer.provide(LeadCoordinator.layer.pipe(Layer.provide(TaskBoardRepo.layer))),
  Layer.provide(Mailbox.defaultLayer),
)

export const defaultLayer = layer.pipe(
  Layer.provide(heartbeatDefaultLayer),
  Layer.provide(Bus.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(SessionCoordinator.defaultLayer),
  Layer.provide(Mailbox.defaultLayer),
  Layer.provide(TaskBoardRepo.layer),
  Layer.provide(RateLimiter.layer),
  Layer.provide(engineerProcessManagerLayer),
)

export * as TeamDaemon from "./daemon"
