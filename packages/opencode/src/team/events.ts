import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import * as Bus from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util"
import { notifyPluginEvent } from "@/plugin"
import { ReviewPacketSchema } from "./review-packet"

const log = Log.create({ service: "team.events" })

export const Event = {
  TeamCreated: BusEvent.define(
    "team.created",
    Schema.Struct({
      teamID: Schema.String,
      leadSessionID: Schema.String,
      goal: Schema.String,
    }),
  ),

  TeamDissolved: BusEvent.define(
    "team.dissolved",
    Schema.Struct({
      teamID: Schema.String,
      reason: Schema.String,
    }),
  ),

  EngineerSpawned: BusEvent.define(
    "engineer.spawned",
    Schema.Struct({
      teamID: Schema.String,
      engineerID: Schema.String,
      sessionID: Schema.String,
      name: Schema.String,
      state: Schema.String,
      taskID: Schema.String,
      taskTitle: Schema.String,
      taskDescription: Schema.String,
      fileScope: Schema.optional(Schema.Array(Schema.String)),
      coordinationWarnings: Schema.optional(Schema.Array(Schema.String)),
      providerID: Schema.optional(Schema.String),
      modelID: Schema.optional(Schema.String),
      agentName: Schema.optional(Schema.String),
      agentColor: Schema.optional(Schema.String),
      fallbackAgent: Schema.optional(Schema.String),
      fallbackProviderID: Schema.optional(Schema.String),
      fallbackModelID: Schema.optional(Schema.String),
    }),
  ),

  EngineerCompleted: BusEvent.define(
    "engineer.completed",
    Schema.Struct({
      teamID: Schema.String,
      engineerID: Schema.String,
      taskId: Schema.String,
      taskTitle: Schema.optional(Schema.String),
      engineerName: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
      reviewPacket: Schema.optional(ReviewPacketSchema),
    }),
  ),

  EngineerFailed: BusEvent.define(
    "engineer.failed",
    Schema.Struct({
      teamID: Schema.String,
      engineerID: Schema.String,
      taskId: Schema.String,
      error: Schema.String,
    }),
  ),

  TaskAssigned: BusEvent.define(
    "task.assigned",
    Schema.Struct({
      teamID: Schema.String,
      taskId: Schema.String,
      engineerID: Schema.String,
    }),
  ),

  TaskUpdated: BusEvent.define(
    "task.updated",
    Schema.Struct({
      teamID: Schema.String,
      taskId: Schema.String,
      status: Schema.String,
      oldStatus: Schema.String,
    }),
  ),

  TaskCompleted: BusEvent.define(
    "task.completed",
    Schema.Struct({
      teamID: Schema.String,
      taskId: Schema.String,
      engineerID: Schema.String,
    }),
  ),

  EngineerProgress: BusEvent.define(
    "engineer.progress",
    Schema.Struct({
      teamID: Schema.String,
      engineerID: Schema.String,
      progressText: Schema.String,
      timestamp: Schema.Number,
    }),
  ),
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
 * Module-level latch flipped to `true` once an `EngineerCompleted`
 * event is emitted from this process. The engineer subprocess uses
 * this to distinguish post-completion teardown errors (safe to swallow
 * as exit 0) from pre-completion failures (must surface as exit 1).
 *
 * Reset by `resetEngineerCompletedLatch` for tests; production code
 * should never need to reset it.
 */
let engineerCompletedLatch = false

export function hasEngineerCompleted(): boolean {
  return engineerCompletedLatch
}

export function resetEngineerCompletedLatch(): void {
  engineerCompletedLatch = false
}

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
  properties: Schema.Schema.Type<D["properties"]>,
): void {
  // Flip the completion latch BEFORE emitting so that any synchronous
  // teardown observer reads the same truth the lead will. Both lead
  // and engineer paths flip the same flag — only the engineer reads it
  // (via team-engineer.ts), but flipping in both keeps semantics
  // uniform regardless of process role.
  if (def.type === "engineer.completed") {
    engineerCompletedLatch = true
  }
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

  // Third publish path: plugin event hooks (best-effort, errors are caught + logged).
  // Only fires from the lead / standalone process — engineer subprocesses do not
  // have the plugin manager loaded (see isEngineerSubprocess guard above).
  notifyPluginEvent({ type: def.type, properties })
}

export function subscribeTeamEvent<D extends BusEvent.Definition>(
  def: D,
  callback: (event: { type: D["type"]; properties: Schema.Schema.Type<D["properties"]> }) => unknown,
): () => void {
  try {
    return Bus.subscribe(def, callback as (event: { type: D["type"]; properties: Schema.Schema.Type<D["properties"]> }) => unknown)
  } catch (err) {
    log.error("failed to subscribe to team event", { type: def.type, error: String(err) })
    return () => {}
  }
}

export * as TeamEvents from "./events"
