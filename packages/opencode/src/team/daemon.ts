import { Effect, Layer, Context, Fiber } from "effect"
import { Bus } from "@/bus"
import { Log } from "@/util"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Event, publishTeamEvent } from "./events"
import { SessionCoordinator } from "./session-coordinator"
import { AppRuntime } from "@/effect/app-runtime"
import { Mailbox, Event as MailboxEvent } from "./mailbox"
import { TaskBoardRepo } from "./task-board"
import { Database } from "@/storage"
import { EngineerSlotTable, TeamStateTable } from "./session-coordinator.sql"
import { TaskBoardTable } from "./task-board.sql"
import { eq, and } from "drizzle-orm"
import { Event as MessageEvent } from "@/session/message-v2"

const log = Log.create({ service: "team.daemon" })

// Heartbeat configuration
const HEARTBEAT_UPDATE_INTERVAL = 30_000 // Update heartbeats every 30 seconds
const HEARTBEAT_CHECK_INTERVAL = 60_000 // Check for stale engineers every 60 seconds
const HEARTBEAT_TIMEOUT = 300_000 // Consider engineer stale after 5 minutes without heartbeat

type RunningEngineer = {
  engineerID: string
  sessionID: SessionID
  teamID: string
  fiber: Fiber.RuntimeFiber<any, any>
  startedAt: number
}

interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly getRunning: () => Effect.Effect<RunningEngineer[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamDaemon") {}

const running = new Map<string, RunningEngineer>()
let heartbeatUpdateInterval: ReturnType<typeof setInterval> | null = null
let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null
let sigintHandlerRegistered = false

/**
 * Graceful shutdown - called on SIGINT to clean up database state.
 * This runs synchronously outside the Effect runtime.
 */
export function gracefulShutdown(): void {
  log.info("graceful shutdown initiated", { runningEngineers: running.size })

  // Clear intervals
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
            .where(eq(TaskBoardTable.id, engineer.current_task))
            .run()

          log.info("released task to pending", { taskID: engineer.current_task })
        }
      }

      // Mark all active teams as completed (so they don't appear as orphaned)
      db.update(TeamStateTable)
        .set({
          state: "completed",
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

const createEngineerLoopEffect = (input: {
  teamID: string
  engineerID: string
  sessionID: SessionID
  name: string
  taskTitle: string
  taskDescription: string
  providerID?: string
  modelID?: string
}) =>
  Effect.gen(function* () {
    const promptService = yield* SessionPrompt.Service

    log.info("starting engineer loop", {
      engineerID: input.engineerID,
      sessionID: input.sessionID,
      model: input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : "(default)",
    })

    // Emit initial progress
    publishTeamEvent(Event.EngineerProgress, {
      teamID: input.teamID,
      engineerID: input.engineerID,
      progressText: `Starting: ${input.taskTitle.slice(0, 40)}${input.taskTitle.length > 40 ? "..." : ""}`,
      timestamp: Date.now(),
    })

    const engineerPrompt = [
      `You are an engineer on team ${input.teamID}. Your name is ${input.name}.`,
      ``,
      `Your assigned task:`,
      `Title: ${input.taskTitle}`,
      `Description: ${input.taskDescription}`,
      ``,
      `Instructions:`,
      `1. Analyze the task and plan your approach`,
      `2. Execute the work using available tools (Read, Write, Edit, Bash, etc.)`,
      `3. Test your changes`,
      `4. Write your findings/report to a file: .tmp/report-${input.name}.md`,
      `5. IMPORTANT: When finished, call team_report with:`,
      `   - status: "completed" (or "blocked"/"failed" if issues)`,
      `   - summary: ONE sentence + path to report file (e.g., "Completed review. Report: .tmp/report-${input.name}.md")`,
      `   - DO NOT send full report content via team_report — keep summary under 200 chars`,
      `6. After reporting, you may check team_tasks for NEW unassigned work.`,
      `   - team_tasks only shows pending, unassigned tasks (NOT your completed task)`,
      `   - If NEW tasks are available, use team_claim to claim one and work on it.`,
      `   - If NO NEW tasks are available, STOP. Do not reclaim your completed task.`,
      ``,
      `Collaboration tools:`,
      `- team_message: Send message to a teammate or lead`,
      `- team_roster: See all teammates and their IDs`,
      `- team_tasks: List available tasks (only shows pending, unassigned tasks)`,
      `- team_claim: Claim an unassigned task`,
      ``,
      `Start working on your assigned task now. Remember to call team_report when done.`,
    ].join("\n")

    // Build model parameter if specified
    const modelParam = input.providerID && input.modelID
      ? { providerID: input.providerID, modelID: input.modelID }
      : undefined

    yield* promptService.prompt({
      sessionID: input.sessionID,
      parts: [{ type: "text", text: engineerPrompt }],
      model: modelParam,
    })
    log.info("engineer completed initial prompt", { engineerID: input.engineerID })

    // Emit working progress
    publishTeamEvent(Event.EngineerProgress, {
      teamID: input.teamID,
      engineerID: input.engineerID,
      progressText: `Working on: ${input.taskTitle.slice(0, 35)}${input.taskTitle.length > 35 ? "..." : ""}`,
      timestamp: Date.now(),
    })

    yield* promptService.loop({ sessionID: input.sessionID })
    log.info("engineer loop completed", { engineerID: input.engineerID })

    running.delete(input.engineerID)
    publishTeamEvent(Event.EngineerCompleted, {
      teamID: input.teamID,
      engineerID: input.engineerID,
      taskId: input.taskTitle,
    })
  })

const startEngineerInBackground = (input: {
  teamID: string
  engineerID: string
  sessionID: SessionID
  name: string
  taskTitle: string
  taskDescription: string
  providerID?: string
  modelID?: string
}) => {
  log.info("forking engineer loop in background", {
    engineerID: input.engineerID,
    model: input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : "(default)",
  })

  const fiber = AppRuntime.runFork(createEngineerLoopEffect(input))

  running.set(input.engineerID, {
    engineerID: input.engineerID,
    sessionID: input.sessionID,
    teamID: input.teamID,
    fiber,
    startedAt: Date.now(),
  })

  log.info("engineer loop forked", { engineerID: input.engineerID, running: running.size })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const coordinator = yield* SessionCoordinator.Service
    const promptService = yield* SessionPrompt.Service
    const mailbox = yield* Mailbox.Service
    const taskBoard = yield* TaskBoardRepo.Service

    let unsubscribers: Array<() => void> = []

    // Update heartbeats for all running engineers
    const updateRunningHeartbeats = () => {
      if (running.size === 0) return

      AppRuntime.runFork(Effect.gen(function* () {
        for (const [engineerID] of running) {
          try {
            yield* coordinator.updateEngineer(engineerID, {})
            log.debug("updated heartbeat", { engineerID })
          } catch (err) {
            log.warn("failed to update heartbeat", { engineerID, error: String(err) })
          }
        }
      }))
    }

    // Check for stale engineers and handle them
    const checkForStaleEngineers = () => {
      AppRuntime.runFork(Effect.gen(function* () {
        const now = Date.now()
        const allEngineers = yield* coordinator.listAllEngineers()

        for (const engineer of allEngineers) {
          if (engineer.state !== "working") continue

          const timeSinceHeartbeat = now - engineer.lastHeartbeat
          if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT) {
            log.warn("engineer heartbeat timeout", {
              engineerID: engineer.engineerID,
              lastHeartbeat: new Date(engineer.lastHeartbeat).toISOString(),
              timeSinceHeartbeat: Math.round(timeSinceHeartbeat / 1000) + "s",
            })

            // Mark engineer as failed
            yield* coordinator.updateEngineer(engineer.engineerID, {
              state: "failed",
              currentTask: null,
            })

            // Mark their task as pending so it can be reclaimed
            if (engineer.currentTask) {
              yield* taskBoard.update(engineer.currentTask as any, {
                status: "pending",
                assigned_engineer_id: null,
              })
              log.info("released task from stale engineer", {
                engineerID: engineer.engineerID,
                taskID: engineer.currentTask,
              })
            }

            // Publish failure event
            publishTeamEvent(Event.EngineerFailed, {
              teamID: engineer.teamID,
              engineerID: engineer.engineerID,
              taskId: engineer.currentTask ?? "unknown",
              error: "Heartbeat timeout - engineer unresponsive",
            })

            // Publish progress event for UI
            publishTeamEvent(Event.EngineerProgress, {
              teamID: engineer.teamID,
              engineerID: engineer.engineerID,
              progressText: "❌ Timeout: unresponsive",
              timestamp: now,
            })

            // Interrupt the fiber if it's still in our running map
            const runningEngineer = running.get(engineer.engineerID)
            if (runningEngineer) {
              log.info("interrupting stale engineer fiber", { engineerID: engineer.engineerID })
              Fiber.interruptFork(runningEngineer.fiber)
              running.delete(engineer.engineerID)
            }
          }
        }
      }))
    }

    const handleLeadMessageReceived = (event: {
      type: string
      properties: {
        messageID: string
        leadSessionID: string
        senderSessionID: string
        priority: "urgent" | "inbox" | "queue"
      }
    }) => {
      log.info("received lead message event", {
        leadSessionID: event.properties.leadSessionID,
        priority: event.properties.priority,
      })

      // Inject notification into lead's session
      const injectNotification = Effect.gen(function* () {
        // Check if this session is actually a lead
        const isLead = yield* coordinator.isLead(event.properties.leadSessionID as SessionID)
        if (!isLead) {
          log.info("session is not a lead, skipping notification")
          return
        }

        // Fetch the message from mailbox
        const messages = yield* mailbox.receiveByPriority({
          recipientSessionID: event.properties.leadSessionID as SessionID,
          priority: event.properties.priority,
        })

        if (messages.length === 0) {
          log.info("no messages found in mailbox")
          return
        }

        const msg = messages[0]
        yield* mailbox.markRead({
          messageID: msg.id,
          recipientSessionID: event.properties.leadSessionID as SessionID,
        })

        const label = event.properties.priority === "urgent"
          ? "[URGENT MESSAGE FROM ENGINEER]"
          : event.properties.priority === "inbox"
            ? "[MESSAGE FROM ENGINEER]"
            : "[LOW PRIORITY MESSAGE]"

        const notificationText = `${label}\n${msg.content}\n\nRespond to acknowledge and take action.`

        log.info("injecting notification into lead session", {
          leadSessionID: event.properties.leadSessionID,
          contentLength: notificationText.length,
        })

        // Inject as a new prompt to wake up the lead
        yield* promptService.prompt({
          sessionID: event.properties.leadSessionID as SessionID,
          parts: [{ type: "text", text: notificationText }],
        })

        log.info("notification injected successfully")
      })

      // Run in background to not block the event handler
      AppRuntime.runFork(injectNotification)
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

      try {
        startEngineerInBackground({
          teamID: event.properties.teamID,
          engineerID: event.properties.engineerID,
          sessionID: event.properties.sessionID as SessionID,
          name: event.properties.name,
          taskTitle: event.properties.taskTitle,
          taskDescription: event.properties.taskDescription,
          providerID: event.properties.providerID,
          modelID: event.properties.modelID,
        })
      } catch (err) {
        log.error("failed to start engineer loop", { engineerID: event.properties.engineerID, error: String(err) })
      }
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
      const engineerEntry = [...running.entries()].find(
        ([, eng]) => eng.sessionID === event.properties.sessionID
      )
      if (!engineerEntry) return

      const [engineerID, engineer] = engineerEntry

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

      const unsubLeadMessage = yield* bus.subscribeCallback(MailboxEvent.LeadMessageReceived, handleLeadMessageReceived)
      unsubscribers.push(unsubLeadMessage)

      const unsubEngineerMessage = yield* bus.subscribeCallback(MailboxEvent.EngineerMessageSent, handleEngineerMessageReceived)
      unsubscribers.push(unsubEngineerMessage)

      const unsubPartUpdated = yield* bus.subscribeCallback(MessageEvent.PartUpdated, handlePartUpdated)
      unsubscribers.push(unsubPartUpdated)

      // Start heartbeat monitoring
      heartbeatUpdateInterval = setInterval(updateRunningHeartbeats, HEARTBEAT_UPDATE_INTERVAL)
      heartbeatCheckInterval = setInterval(checkForStaleEngineers, HEARTBEAT_CHECK_INTERVAL)

      // Register SIGINT handler for graceful shutdown (only once)
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

      // Clear heartbeat intervals
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

      for (const [engineerID, engineer] of running) {
        log.info("interrupting engineer", { engineerID })
        yield* Fiber.interrupt(engineer.fiber)
      }
      running.clear()

      log.info("team daemon stopped")
    })

    const getRunning = Effect.fn("TeamDaemon.getRunning")(function* () {
      return Array.from(running.values())
    })

    // Auto-start the daemon when the layer is built
    yield* start()

    // Clean up on shutdown
    yield* Effect.addFinalizer(() => stop())

    return Service.of({ start, stop, getRunning })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(SessionCoordinator.defaultLayer),
  Layer.provide(Mailbox.defaultLayer),
  Layer.provide(TaskBoardRepo.layer),
)

export * as TeamDaemon from "./daemon"
