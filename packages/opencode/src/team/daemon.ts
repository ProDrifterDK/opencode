import { Effect, Layer, Context, Cause, Schema } from "effect"
import { Bus } from "@/bus"
import { Log } from "@/util"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Event, publishTeamEvent } from "./events"
import { reconcileExitedEngineer } from "./engineer-lifecycle"
import { SessionCoordinator, type EngineerSlot } from "./session-coordinator"
import { AppRuntime } from "@/effect/app-runtime"
import { Mailbox, Event as MailboxEvent } from "./mailbox"
import { TaskBoardRepo } from "./task-board"
import { Database } from "@/storage"
import { EngineerSlotTable, TeamStateTable } from "./session-coordinator.sql"
import { TaskBoardTable } from "./task-board.sql"
import { eq } from "drizzle-orm"
import { Event as MessageEvent } from "@/session/message-v2"
import {
  ENGINEER_MAX_RUNTIME,
  HEARTBEAT_UPDATE_INTERVAL,
  HEARTBEAT_CHECK_INTERVAL,
  HEARTBEAT_TIMEOUT,
  ENGINEER_KILL_TIMEOUT_MS,
  MAILBOX_MAX_AGE_MS,
} from "./constants"
import { RateLimiter } from "./rate-limiter"
import { Service as HeartbeatMonitorService, layer as heartbeatLayer } from "./heartbeat"
import { LeadCoordinator } from "./lead-coordinator"
import { GitManager } from "./git-manager"
import { buildEngineerReportMessage, buildTeamCompleteMessage, isTeamWorkComplete } from "./completion"
import { encodeReviewPacket } from "./review-packet"
import { rememberCompletion } from "./completion-deduper"
import { findTeamReportNotification, hasTeamCompleteNotification, resolveLeadNotificationSender, selectUnreadMessageForEvent, teamCompleteSenderSessionID } from "./mailbox-notification"
import {
  Service as EngineerProcessManager,
  layer as engineerProcessManagerLayer,
  terminateSubprocess,
  type KillableSubprocess,
} from "./engineer-process-manager"
import type { EngineerID, TeamID } from "./types"
import type { TaskBoardID } from "./task-board.sql"
import type { MailboxID } from "./mailbox.sql"
import { buildReplyInstruction, formatTeamMessageLabel, type SenderIdentity } from "./message-routing"
import {
  type RunningEngineer,
  running,
  setRunning,
  getRunningEngineer,
  deleteRunning,
  iterAllRunning,
  countAllRunning,
  terminateRunningEngineersForShutdown,
} from "./daemon-running"

const log = Log.create({ service: "team.daemon" })

// Phase 3 of A3 — graceful kill with SIGTERM→SIGKILL escalation. Fire
// and forget: callers don't await the exit (the centralized exit
// handler does the cleanup). Errors are swallowed so a missing pipe
// or already-dead child doesn't crash callers in a generator.
const killEngineerSubprocess = (
  engineerID: string,
  pid: number,
  sub: import("bun").Subprocess | undefined,
): void => {
  if (!sub) return
  // Cast: the production handle is a Bun.Subprocess. The helper accepts
  // a structural KillableSubprocess so tests can pass simpler fakes.
  void terminateSubprocess(sub as unknown as KillableSubprocess, {
    timeoutMs: ENGINEER_KILL_TIMEOUT_MS,
  }).catch((err) => {
    log.warn("terminateSubprocess threw", { engineerID, pid, error: String(err) })
  })
}

const terminateRunningEngineers = (): number =>
  terminateRunningEngineersForShutdown((engineerID, pid, sub) => {
    log.info("killing engineer subprocess on graceful shutdown", {
      engineerID,
      pid,
    })
    killEngineerSubprocess(engineerID, pid, sub)
  })

// Heartbeat constants are defined in ./constants and imported above.
// The daemon's setInterval sweep acts as a backstop for teams that
// HeartbeatMonitor is not actively watching. For teams with an active
// HeartbeatMonitor scope the sweep is skipped (isMonitoring returns true).

interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly getRunning: () => Effect.Effect<RunningEngineer[]>
  readonly resumeTeamMonitoring: (teamID: TeamID) => Effect.Effect<{ respawned: number; tasksReset: number }, Error>
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

  terminateRunningEngineers()

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

  // Do not clear the running map here. The tracked subprocess handles are
  // still needed by the async `.exited` handlers and by TeamDaemon.stop()
  // if the normal Effect finalizer path runs after this signal handler.
}

// Engineer loop body lives in `./engineer-loop.ts`. It is no longer
// invoked in-process here; instead, the lead spawns a subprocess via
// `EngineerProcessManager.spawn` (Phase 1 of A3) and the new
// `team-engineer-run` CLI subcommand calls `runEngineerLoop` inside
// the child. Process isolation means a crashing engineer can't take
// the lead with it.

const startEngineerInBackground = (
  input: {
    teamID: string
    engineerID: string
    sessionID: SessionID
    name: string
    taskId: string
    taskTitle: string
    taskDescription: string
    fileScope?: readonly string[]
    coordinationWarnings?: readonly string[]
    providerID?: string
    modelID?: string
    fallbackProviderID?: string
    fallbackModelID?: string
    teammates?: Array<{ name: string; engineerID: string; task?: string }>
  },
  // Injection seam: the caller (inside `layer`) passes the locally-defined
  // `attachExitHandler` closure so that `startEngineerInBackground` can
  // remain a module-level function while still capturing `coordinator`
  // from the layer scope. Tests may inject a stub here.
  attachExitHandler: (params: {
    teamID: TeamID
    engineerID: EngineerID
    subprocess: import("bun").Subprocess
  }) => void,
) =>
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
      fileScope: input.fileScope,
      coordinationWarnings: input.coordinationWarnings,
      teammates: input.teammates,
      name: input.name,
      providerID: input.providerID,
      modelID: input.modelID,
      fallbackProviderID: input.fallbackProviderID,
      fallbackModelID: input.fallbackModelID,
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
      eventReaderDone: spawned.eventReaderDone,
    })

    // Phase 3 of A3: wire the centralized exit handler. This is the
    // single cleanup path for the lead's `running` map — whether the
    // engineer exits cleanly, crashes, gets OOM-killed, or is killed
    // by `terminateSubprocess`, the handler observes one resolution of
    // `subprocess.exited` and runs `deleteRunning` exactly once.
    attachExitHandler({
      teamID: input.teamID as TeamID,
      engineerID: input.engineerID as EngineerID,
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

    /**
     * Phase 3 of A3 — centralized engineer exit handler.
     *
     * Attached after every successful spawn. When the subprocess's
     * `.exited` Promise resolves (for ANY reason: clean exit, crash,
     * OOM, manual kill), this function:
     *
     *   1. Looks up the slot. If already cleaned up by an earlier
     *      pass (e.g. a manual `terminateEngineer` already deleted
     *      it), returns silently — race-safe.
     *   2. Deletes the slot from the lead's `running` map. This is
     *      the single source of truth for cleanup; `terminateEngineer`
     *      no longer touches `deleteRunning` itself.
     *   3. Re-reads the engineer's DB state. If it's still "working"
     *      (the engineer crashed before the lead processed an
     *      EngineerCompleted/EngineerFailed event for it), marks the
     *      slot `failed` and emits `EngineerFailed` with the exit code
     *      in the reason. The heartbeat sweep gates on
     *      `state === "working"`, so once this fires the sweep no
     *      longer competes.
     */
    const attachExitHandler = (params: {
      teamID: TeamID
      engineerID: EngineerID
      subprocess: import("bun").Subprocess
    }) => {
      void params.subprocess.exited
        .then(async (code) => {
          const slot = getRunningEngineer(params.teamID, params.engineerID)

          // Wait for the engineer's stdout JSONL reader to drain before
          // reconciling DB state. A clean-exit engineer publishes
          // `EngineerCompleted` to stdout right before terminating; the
          // line is still buffered when `.exited` resolves. Without this
          // await, `reconcileExitedEngineer` reads state="working", marks
          // the engineer failed, and the heartbeat sweep fires a spurious
          // `all-engineers-failed` urgent. A 5s timeout guards against a
          // wedged reader so we never hang the cleanup path forever.
          if (slot?.eventReaderDone) {
            const READER_DRAIN_TIMEOUT_MS = 5_000
            let timer: ReturnType<typeof setTimeout> | undefined
            const TIMED_OUT = Symbol("reader-drain-timeout")
            const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
              timer = setTimeout(() => resolve(TIMED_OUT), READER_DRAIN_TIMEOUT_MS)
            })
            const winner = await Promise.race([
              slot.eventReaderDone.then(() => "drained" as const),
              timeoutPromise,
            ]).catch(() => "drained" as const) // reader rejection → proceed
            if (timer !== undefined) clearTimeout(timer)
            if (winner === TIMED_OUT) {
              log.warn("engineer stdout reader did not drain before reconcile", {
                engineerID: params.engineerID,
                timeoutMs: READER_DRAIN_TIMEOUT_MS,
              })
            }
          }

          AppRuntime.runFork(
            Effect.gen(function* () {
              const engineerSlot = yield* coordinator.getEngineer(params.engineerID)
              const action = reconcileExitedEngineer({
                slot,
                currentState: engineerSlot?.state,
                code: code ?? null,
                completedEventSeen: slot?.completedAt !== undefined,
              })

              if (action.kind === "noop") {
                log.debug("exit handler: slot already gone, skipping", {
                  engineerID: params.engineerID,
                  code,
                })
                return
              }

              deleteRunning(params.teamID, params.engineerID)

              log.info("engineer subprocess exited", {
                engineerID: params.engineerID,
                pid: slot!.pid,
                code,
              })

              if (action.kind === "delete") return

              // action.kind === "delete-and-fail": engineer crashed while working
              yield* coordinator
                .updateEngineer(params.engineerID, { state: "failed" })
                .pipe(Effect.ignore)

              publishTeamEvent(Event.EngineerFailed, {
                teamID: params.teamID,
                engineerID: params.engineerID,
                taskId: engineerSlot?.currentTask ?? "unknown",
                error: action.reason,
              })
            }).pipe(Effect.catchCause(() => Effect.void)),
          )
        })
        .catch((err) => log.error("exit handler failed", { err }))
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
          // Phase 3 of A3: graceful kill (SIGTERM, escalate to SIGKILL
          // after ENGINEER_KILL_TIMEOUT_MS). The `.exited` handler
          // attached at spawn time owns the `running` map cleanup, so
          // we don't call deleteRunning here — that would create two
          // racing cleanup paths. Fire and forget.
          killEngineerSubprocess(engineer.engineerID, runningEngineer.pid, runningEngineer.subprocess)
        }
      })

    const maybeSendTeamComplete = Effect.fn("TeamDaemon.maybeSendTeamComplete")(function* (teamID: TeamID) {
      const team = yield* coordinator.getTeam(teamID)
      if (!team) return
      const tasks = yield* taskBoard.list({ team_id: teamID })
      const engineers = yield* coordinator.listTeamEngineers(teamID)
      if (!isTeamWorkComplete({ tasks, engineers })) return
      const messages = yield* mailbox.peek(team.leadSessionID)
      if (hasTeamCompleteNotification(messages, { recipientSessionID: team.leadSessionID, teamID })) return

      yield* mailbox.send({
        senderSessionID: teamCompleteSenderSessionID(team),
        recipientSessionID: team.leadSessionID,
        type: "team_complete",
        content: buildTeamCompleteMessage({
          teamID,
          completedTasks: tasks.length,
        }),
        priority: "urgent",
      })
    })

    // Sweep for engineers whose heartbeat has gone silent or whose
    // total runtime has passed ENGINEER_MAX_RUNTIME, and terminate
    // them. Driven by the setInterval registered in `start()` below.
    // Backstop only: skips teams already covered by HeartbeatMonitor.
    const checkForStaleEngineers = () => {
      AppRuntime.runFork(Effect.gen(function* () {
        const now = Date.now()
        const allEngineers = yield* coordinator.listAllEngineers()
        const teamIDs = new Set(allEngineers.map((engineer) => engineer.teamID as TeamID))

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

        for (const teamID of teamIDs) {
          yield* maybeSendTeamComplete(teamID)
        }
      }))
    }

    // Age-based mailbox GC. Messages older than MAILBOX_MAX_AGE_MS are
    // orphans (sender/recipient session likely already gone) — drop them
    // so the mailbox table doesn't grow unbounded. Driven by the same
    // setInterval as `checkForStaleEngineers`.
    const purgeStaleMailboxMessages = () => {
      AppRuntime.runFork(
        mailbox.purgeOlderThan(MAILBOX_MAX_AGE_MS).pipe(
          Effect.tap((count) =>
            count > 0
              ? Effect.sync(() => log.info("mailbox GC purged old messages", { count }))
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("mailbox GC failed", { cause: Cause.pretty(cause) })),
          ),
        ),
      )
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
        const recipientSessionID = event.properties.recipientSessionID as SessionID
        const messages = yield* mailbox.peek(recipientSessionID)
        const msg = selectUnreadMessageForEvent(messages, {
          messageID: event.properties.messageID as MailboxID,
          recipientSessionID,
        })

        if (!msg) {
          log.info("mailbox event message already handled or missing", {
            messageID: event.properties.messageID,
            recipientSessionID: event.properties.recipientSessionID,
          })
          return
        }

        yield* mailbox.markRead({
          messageID: msg.id,
          recipientSessionID,
        })

        const senderEngineer = yield* coordinator.getEngineerBySession(msg.sender_session_id)
        const sender = resolveLeadNotificationSender({
          senderSessionID: msg.sender_session_id,
          leadSessionID: recipientSessionID,
          senderEngineer,
        })
        const label = formatTeamMessageLabel({ sender, priority: event.properties.priority })

        const notificationText = `${label}\n${msg.content}\n\n${buildReplyInstruction(sender)} Respond to acknowledge and take action.`

        log.info("injecting notification into lead session", {
          leadSessionID: event.properties.recipientSessionID,
          contentLength: notificationText.length,
        })

        // Inject as a new prompt to wake up the lead
        yield* promptService.prompt({
          sessionID: recipientSessionID,
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
      type: typeof MailboxEvent.Received.type
      properties: Schema.Schema.Type<typeof MailboxEvent.Received.properties>
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

        const recipientSessionID = event.properties.recipientSessionID as SessionID
        const recipientEngineer = yield* coordinator.getEngineerBySession(recipientSessionID)
        const team = recipientEngineer ? yield* coordinator.getTeam(recipientEngineer.teamID) : null

        const messages = yield* mailbox.peek(recipientSessionID)
        const msg = selectUnreadMessageForEvent(messages, {
          messageID: event.properties.messageID as MailboxID,
          recipientSessionID,
        })

        if (!msg) {
          log.info("mailbox event message for engineer already handled or missing", {
            messageID: event.properties.messageID,
            recipientSessionID: event.properties.recipientSessionID,
          })
          return
        }

        yield* mailbox.markRead({
          messageID: msg.id,
          recipientSessionID,
        })

        const senderEngineer = yield* coordinator.getEngineerBySession(msg.sender_session_id)
        const sender: SenderIdentity = team?.leadSessionID === msg.sender_session_id
          ? { type: "lead" }
          : senderEngineer
            ? { type: "engineer", name: senderEngineer.name, engineerID: senderEngineer.engineerID }
            : { type: "unknown" }

        const label = formatTeamMessageLabel({ sender, priority: event.properties.priority })

        const notificationText = `${label}\n${msg.content}\n\n${buildReplyInstruction(sender)}`

        log.info("injecting notification into engineer session", {
          recipientSessionID: event.properties.recipientSessionID,
          senderName: sender.type === "engineer" ? sender.name : sender.type,
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
      type: typeof Event.EngineerSpawned.type
      properties: Schema.Schema.Type<typeof Event.EngineerSpawned.properties>
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

        yield* startEngineerInBackground(
          {
            teamID: event.properties.teamID,
            engineerID: event.properties.engineerID,
            sessionID: event.properties.sessionID as SessionID,
            name: event.properties.name,
            taskId: event.properties.taskID,
            taskTitle: event.properties.taskTitle,
            taskDescription: event.properties.taskDescription,
            fileScope: event.properties.fileScope,
            coordinationWarnings: event.properties.coordinationWarnings,
            providerID: event.properties.providerID,
            modelID: event.properties.modelID,
            fallbackProviderID: event.properties.fallbackProviderID,
            fallbackModelID: event.properties.fallbackModelID,
            teammates: otherEngineers,
          },
          attachExitHandler,
        )
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

    const reportedCompletions = new Set<string>()

    const handleEngineerCompleted = (event: {
      type: typeof Event.EngineerCompleted.type
      properties: Schema.Schema.Type<typeof Event.EngineerCompleted.properties>
    }) => {
      const teamID = event.properties.teamID as TeamID
      const engineerID = event.properties.engineerID as EngineerID
      const taskID = event.properties.taskId as TaskBoardID
      const completion = rememberCompletion(reportedCompletions, {
        teamID,
        engineerID,
        taskID,
      })

      const slot = getRunningEngineer(teamID, engineerID)
      if (slot && slot.completedAt === undefined) slot.completedAt = Date.now()

      AppRuntime.runFork(Effect.gen(function* () {
        if (completion.kind === "duplicate") {
          log.warn("duplicate EngineerCompleted ignored", {
            teamID,
            engineerID,
            taskID,
          })
          return
        }
        const team = yield* coordinator.getTeam(teamID)
        if (!team) return

        const engineer = yield* coordinator.getEngineer(engineerID)
        const task = yield* taskBoard.get(taskID)

        if (task) {
          yield* taskBoard.update(taskID, {
            status: "completed",
            completed_at: task.completed_at ?? Date.now(),
            review_packet: event.properties.reviewPacket ? encodeReviewPacket(event.properties.reviewPacket) : undefined,
          })
        }
        yield* coordinator.updateEngineer(engineerID, {
          state: "idle",
          currentTask: null,
        }).pipe(Effect.ignore)

        const reportSenderSessionID = engineer?.sessionID ?? team.leadSessionID
        const reportContent = buildEngineerReportMessage({
          engineerName: event.properties.engineerName ?? engineer?.name ?? event.properties.engineerID,
          taskTitle: event.properties.taskTitle ?? task?.title ?? event.properties.taskId,
          summary: event.properties.summary ?? "Completed.",
          reviewPacket: event.properties.reviewPacket,
        })
        const existingReport = findTeamReportNotification(yield* mailbox.peek(team.leadSessionID), {
          recipientSessionID: team.leadSessionID,
          senderSessionID: reportSenderSessionID,
          content: reportContent,
        })
        if (existingReport) {
          handleLeadMessageReceived({
            type: MailboxEvent.Received.type,
            properties: {
              messageID: existingReport.id,
              senderSessionID: existingReport.sender_session_id,
              recipientSessionID: existingReport.recipient_session_id,
              priority: existingReport.priority,
            },
          })
        } else {
          yield* mailbox.send({
            senderSessionID: reportSenderSessionID,
            recipientSessionID: team.leadSessionID,
            type: "team_report",
            content: reportContent,
            priority: "inbox",
          })
        }

        yield* maybeSendTeamComplete(teamID)
      }).pipe(Effect.catchCause((cause) =>
        Effect.sync(() => log.error("team completion check failed", { cause: Cause.pretty(cause) })),
      )))
    }

    // Track last emitted tool per engineer to avoid duplicate progress updates
    const lastToolPerEngineer = new Map<string, string>()

    const handlePartUpdated = (event: {
      type: typeof MessageEvent.PartUpdated.type
      properties: Schema.Schema.Type<typeof MessageEvent.PartUpdated.properties>
    }) => {
      // Only process tool parts that are running
      if (event.properties.part.type !== "tool") return
      if ((event.properties.part.state as { status?: string } | undefined)?.status !== "running") return

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

    /**
     * O4 — Resume monitoring for a previously terminated team.
     *
     * Pre-conditions: caller (TeamResumeTool) has already flipped the
     * team back to `active` via `coordinator.resumeTeam`. Here we wire
     * the live runtime back up:
     *
     *   1. Re-attach the heartbeat monitor (idempotent — guarded by
     *      `isMonitoring`).
     *   2. Reset any tasks that the prior process left in `in-progress`
     *      back to `pending` so they can be re-claimed. The original
     *      subprocess died with the daemon; the slot was marked
     *      `failed` by `gracefulShutdown`. We do not re-spawn failed
     *      engineers — that's the lead's call (kill+spawn or rely on
     *      the remaining idle engineers + team_assign).
     *   3. Re-spawn engineers whose state is still `working` or
     *      `blocked` (rare; only happens if shutdown didn't run). For
     *      `idle` engineers we leave them alone — they'll pick up
     *      pending work via team_assign / team_claim like normal.
     */
    // Resolve once at layer init so resumeTeamMonitoring (and any other
    // Service method) doesn't leak `GitManager.Service | EngineerProcessManager`
    // into the public Effect context. These layers are already provided
    // by `defaultLayer` below, so the resolution is guaranteed at runtime.
    const gitManagerSvc = yield* GitManager.Service
    const processManagerSvc = yield* EngineerProcessManager

    const resumeTeamMonitoring = Effect.fn("TeamDaemon.resumeTeamMonitoring")(function* (teamID: TeamID) {
      log.info("resuming team monitoring", { teamID })

      const team = yield* coordinator.getTeam(teamID).pipe(
        Effect.mapError((err: unknown) => new Error(String(err))),
      )
      if (!team) {
        return yield* Effect.fail(new Error(`Team not found: ${teamID}`))
      }

      // Re-attach heartbeat monitor (idempotent).
      const alreadyMonitored = yield* heartbeatMonitor.isMonitoring(teamID)
      if (!alreadyMonitored) {
        yield* heartbeatMonitor
          .startTeamMonitoring(teamID, team.leadSessionID)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.warn("failed to start heartbeat monitoring on resume", {
                  teamID,
                  error: Cause.pretty(cause),
                }),
              ),
            ),
          )
      }

      // Reset any leftover in-progress tasks back to pending. The
      // engineer subprocess that owned them is gone; releasing the
      // task lets `team_assign` / `team_claim` re-pick it up.
      const allTasks = yield* taskBoard.list({ team_id: teamID }).pipe(
        Effect.mapError((err: unknown) => new Error(String(err))),
      )
      let tasksReset = 0
      for (const task of allTasks) {
        if (task.status === "in-progress") {
          yield* taskBoard
            .update(task.id, { status: "pending", assigned_engineer_id: null })
            .pipe(Effect.mapError((err: unknown) => new Error(String(err))))
          tasksReset++
        }
      }

      // Re-spawn engineers that were still active when the daemon died.
      // `gracefulShutdown` flips `working` slots to `failed`, so the
      // common case here is that nothing needs re-spawning. We still
      // handle `working` and `blocked` defensively in case the daemon
      // crashed without the SIGINT/SIGTERM path.
      const engineers = yield* coordinator.listTeamEngineers(teamID).pipe(
        Effect.mapError((err: unknown) => new Error(String(err))),
      )

      let respawned = 0
      for (const slot of engineers) {
        if (slot.state !== "working" && slot.state !== "blocked") continue
        const alreadyRunning = getRunningEngineer(teamID, slot.engineerID)
        if (alreadyRunning) continue

        const taskID = slot.currentTask
        if (!taskID) continue
        const task = allTasks.find((t) => t.id === taskID)
        if (!task) continue

        log.info("respawning engineer on resume", {
          engineerID: slot.engineerID,
          taskID,
        })

        yield* startEngineerInBackground(
          {
            teamID,
            engineerID: slot.engineerID,
            sessionID: slot.sessionID,
            name: slot.name,
            taskId: taskID,
            taskTitle: task.title,
            taskDescription: task.description ?? "",
          },
          attachExitHandler,
        ).pipe(
          // Provide the captured services so the public method signature
          // doesn't require GitManager/EngineerProcessManager from callers.
          Effect.provideService(GitManager.Service, gitManagerSvc),
          Effect.provideService(EngineerProcessManager, processManagerSvc),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.error("respawn failed on resume", {
                engineerID: slot.engineerID,
                error: Cause.pretty(cause),
              }),
            ),
          ),
        )
        respawned++
      }

      log.info("team resumed", { teamID, respawned, tasksReset })
      return { respawned, tasksReset }
    })

    const start = Effect.fn("TeamDaemon.start")(function* () {
      log.info("starting team daemon")

      const unsubSpawned = yield* bus.subscribeCallback(Event.EngineerSpawned, handleEngineerSpawned)
      unsubscribers.push(unsubSpawned)

      const unsubCompleted = yield* bus.subscribeCallback(Event.EngineerCompleted, handleEngineerCompleted)
      unsubscribers.push(unsubCompleted)

      const unsubMailbox = yield* bus.subscribeCallback(MailboxEvent.Received, handleMailboxReceived)
      unsubscribers.push(unsubMailbox)

      const unsubPartUpdated = yield* bus.subscribeCallback(MessageEvent.PartUpdated, handlePartUpdated)
      unsubscribers.push(unsubPartUpdated)

      heartbeatUpdateInterval = setInterval(updateRunningHeartbeats, HEARTBEAT_UPDATE_INTERVAL)
      // Both sweeps are runFork (fire-and-forget) — they race in the same tick. Independent (different keys) so race is harmless.
      heartbeatCheckInterval = setInterval(() => {
        checkForStaleEngineers()
        purgeStaleMailboxMessages()
      }, HEARTBEAT_CHECK_INTERVAL)

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

    return Service.of({ start, stop, getRunning, resumeTeamMonitoring })
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
