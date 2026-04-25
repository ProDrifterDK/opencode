import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import * as Bus from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util"

const log = Log.create({ service: "team.events" })

export const Event = {
  TeamCreated: BusEvent.define("team.created", z.object({
    teamID: z.string(),
    leadSessionID: z.string(),
    goal: z.string(),
  })),

  TeamDissolved: BusEvent.define("team.dissolved", z.object({
    teamID: z.string(),
    reason: z.string(),
  })),

  EngineerSpawned: BusEvent.define("engineer.spawned", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    sessionID: z.string(),
    name: z.string(),
    state: z.string(),
    taskID: z.string(),
    taskTitle: z.string(),
    taskDescription: z.string(),
    providerID: z.string().optional(),
    modelID: z.string().optional(),
    agentName: z.string().optional(),
    agentColor: z.string().optional(),
  })),

  EngineerCompleted: BusEvent.define("engineer.completed", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    taskId: z.string(),
  })),

  EngineerFailed: BusEvent.define("engineer.failed", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    taskId: z.string(),
    error: z.string(),
  })),

  TaskAssigned: BusEvent.define("task.assigned", z.object({
    teamID: z.string(),
    taskId: z.string(),
    engineerID: z.string(),
  })),

  TaskUpdated: BusEvent.define("task.updated", z.object({
    teamID: z.string(),
    taskId: z.string(),
    status: z.string(),
    oldStatus: z.string(),
  })),

  TaskCompleted: BusEvent.define("task.completed", z.object({
    teamID: z.string(),
    taskId: z.string(),
    engineerID: z.string(),
  })),

  EngineerProgress: BusEvent.define("engineer.progress", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    progressText: z.string(),
    timestamp: z.number(),
  })),
} as const

/**
 * True when the current process is an engineer subprocess spawned by
 * the lead via EngineerProcessManager. Set in the spawn `env`
 * (OPENCODE_TEAM_ENGINEER=1). When true, publishTeamEvent forwards
 * events to stdout as JSON-lines instead of emitting on GlobalBus —
 * GlobalBus is process-local and the lead can't see it from a
 * different process anyway. The lead-side reader
 * (engineer-event-reader.ts) decodes those lines and republishes them
 * onto the lead's Bus + GlobalBus.
 */
const isEngineerSubprocess = (): boolean => process.env.OPENCODE_TEAM_ENGINEER === "1"

/**
 * Encode an event as a JSON-line and write it to stdout. Defensive:
 * if stdout.write throws (broken pipe, etc.) we catch + log + drop the
 * event. The engineer must NOT crash because the lead disconnected.
 */
function writeEngineerEventToStdout(type: string, properties: unknown): void {
  let line: string
  try {
    line = JSON.stringify({ type, properties })
  } catch (err) {
    log.error("failed to serialize engineer event", { type, error: String(err) })
    return
  }
  try {
    process.stdout.write(line + "\n")
  } catch (err) {
    log.error("failed to write engineer event to stdout", { type, error: String(err) })
  }
}

export function publishTeamEvent<D extends BusEvent.Definition>(
  def: D,
  properties: z.output<D["properties"]>,
): void {
  if (isEngineerSubprocess()) {
    // engineer subprocess publishes only via stdout — local Bus is the lead's path.
    // Bus.publish is intentionally skipped here: there are no in-process subscribers
    // to team events on the engineer side, and GlobalBus is process-local so it
    // would never reach the lead. The lead-side reader (engineer-event-reader.ts)
    // decodes these JSON-lines and republishes them on the lead's Bus + GlobalBus.
    writeEngineerEventToStdout(def.type, properties)
    return
  }

  // Lead / standalone process: dual-publish is intentional — each path serves a
  // distinct subscriber set and neither is redundant:
  //
  //   Bus.publish  →  Effect Bus PubSub  →  daemon.ts subscribeCallback(EngineerSpawned)
  //                   (Bus.publish also emits to GlobalBus internally, but with
  //                    directory=<instanceDir>, which the TUI filters OUT for team events)
  //
  //   GlobalBus.emit(directory:"global")  →  SDK SSE stream  →  TUI sync.tsx
  //                   (event.ts:16 matches only directory==="global", so team events
  //                    must be emitted here explicitly — Bus.publish's internal
  //                    GlobalBus emit uses the instance directory, not "global")
  //
  // Silently ignore "No context found" errors from Bus.publish — they occur when
  // publishTeamEvent is called outside an active instance (e.g. tests,
  // gracefulShutdown). GlobalBus.emit below is always safe and covers the TUI path.
  Bus.publish(def, properties).catch((err) => {
    const msg = String(err)
    if (!msg.includes("No context found for instance")) {
      log.error("failed to publish team event", { type: def.type, error: msg })
    }
  })

  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: def.type,
      properties,
    },
  })
}

export function subscribeTeamEvent<D extends BusEvent.Definition>(
  def: D,
  callback: (event: { type: D["type"]; properties: z.infer<D["properties"]> }) => unknown,
): () => void {
  try {
    return Bus.subscribe(def, callback)
  } catch (err) {
    log.error("failed to subscribe to team event", { type: def.type, error: String(err) })
    return () => {}
  }
}

export * as TeamEvents from "./events"
