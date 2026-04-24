import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import * as Bus from "@/bus"
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

export function publishTeamEvent<D extends BusEvent.Definition>(
  def: D,
  properties: z.output<D["properties"]>,
): void {
  Bus.publish(def, properties).catch((err) => {
    log.error("failed to publish team event", { type: def.type, error: String(err) })
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
