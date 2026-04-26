import { describe, test, expect, mock, beforeEach } from "bun:test"
import { Exit, Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { Event, publishTeamEvent, subscribeTeamEvent } from "./events"
import * as PluginModule from "@/plugin"
import type { Hooks } from "@opencode-ai/plugin"

// Thin shim around Effect Schema's decode API to preserve the
// `safeParse(...).success` shape these tests historically asserted on.
// The team event schemas are no longer Zod, so the Zod safeParse method
// is gone — but the test contract (success boolean for "does this
// payload validate?") is unchanged.
function safeParse<S extends Schema.Top>(schema: S, value: unknown): { success: boolean } {
  const exit = Schema.decodeUnknownExit(schema as unknown as Schema.Decoder<unknown>)(value)
  return { success: Exit.isSuccess(exit) }
}

describe("TeamEvents", () => {
  test("Event definitions have correct types", () => {
    expect(Event.TeamCreated.type).toBe("team.created")
    expect(Event.TeamDissolved.type).toBe("team.dissolved")
    expect(Event.EngineerSpawned.type).toBe("engineer.spawned")
    expect(Event.EngineerCompleted.type).toBe("engineer.completed")
    expect(Event.EngineerFailed.type).toBe("engineer.failed")
    expect(Event.EngineerProgress.type).toBe("engineer.progress")
    expect(Event.TaskAssigned.type).toBe("task.assigned")
    expect(Event.TaskUpdated.type).toBe("task.updated")
    expect(Event.TaskCompleted.type).toBe("task.completed")
  })

  test("Event definitions use BusEvent.define correctly", () => {
    const allEvents = [
      Event.TeamCreated,
      Event.TeamDissolved,
      Event.EngineerSpawned,
      Event.EngineerCompleted,
      Event.EngineerFailed,
      Event.EngineerProgress,
      Event.TaskAssigned,
      Event.TaskUpdated,
      Event.TaskCompleted,
    ]

    for (const evt of allEvents) {
      expect(evt.type).toBeTruthy()
      expect(evt.properties).toBeDefined()
    }
  })

  test("Event definitions are registered in BusEvent registry", () => {
    const payloads = BusEvent.payloads()
    expect(payloads.length).toBeGreaterThanOrEqual(9)
  })

  test("Event payloads validate against their schemas", () => {
    const teamCreatedProps = Event.TeamCreated.properties
    const parsed = safeParse(teamCreatedProps, {
      teamID: "team_123",
      leadSessionID: "sess_456",
      goal: "implement auth",
    })
    expect(parsed.success).toBe(true)

    const engineerFailedProps = Event.EngineerFailed.properties
    const parsed2 = safeParse(engineerFailedProps, {
      teamID: "team_x",
      engineerID: "eng_bad",
      taskId: "task_1",
      error: "timeout exceeded",
    })
    expect(parsed2.success).toBe(true)

    const taskUpdatedProps = Event.TaskUpdated.properties
    const parsed3 = safeParse(taskUpdatedProps, {
      teamID: "team_z",
      taskId: "task_3",
      status: "in-progress",
      oldStatus: "pending",
    })
    expect(parsed3.success).toBe(true)
  })

  test("Event payloads reject invalid data", () => {
    const teamCreatedProps = Event.TeamCreated.properties
    const parsed = safeParse(teamCreatedProps, {
      teamID: 123,
    })
    expect(parsed.success).toBe(false)
  })

  test("EngineerSpawned requires concrete task details", () => {
    // The schema evolved: every spawn now carries a concrete task
    // (see tool/team.ts team_spawn — taskID is always task.id, never
    // null). The earlier "nullable taskId" contract is gone.
    const props = Event.EngineerSpawned.properties

    const complete = safeParse(props, {
      teamID: "team_1",
      engineerID: "eng_1",
      sessionID: "sess_1",
      name: "engineer-1",
      state: "working",
      taskID: "task_1",
      taskTitle: "do the thing",
      taskDescription: "describe the thing",
    })
    expect(complete.success).toBe(true)

    // Optional fields should pass when present.
    const withOptional = safeParse(props, {
      teamID: "team_1",
      engineerID: "eng_1",
      sessionID: "sess_1",
      name: "engineer-1",
      state: "working",
      taskID: "task_1",
      taskTitle: "do the thing",
      taskDescription: "describe the thing",
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
      agentName: "architect",
      agentColor: "blue",
    })
    expect(withOptional.success).toBe(true)

    // Missing taskID should now fail — spawning without a task is no
    // longer a valid state.
    const missingTask = safeParse(props, {
      teamID: "team_1",
      engineerID: "eng_1",
      sessionID: "sess_1",
      name: "engineer-1",
      state: "working",
      taskTitle: "do the thing",
      taskDescription: "describe the thing",
    })
    expect(missingTask.success).toBe(false)
  })

  test("publishTeamEvent and subscribeTeamEvent are callable functions", () => {
    expect(typeof publishTeamEvent).toBe("function")
    expect(typeof subscribeTeamEvent).toBe("function")
  })

  test("Event object has all 9 event types", () => {
    // EngineerProgress was added in commit c9acfe888 to carry live
    // tool-usage updates from the daemon to the TUI. If you add or
    // remove events, update both this length and the contains list.
    const events = Object.keys(Event)
    expect(events).toHaveLength(9)
    expect(events).toContain("TeamCreated")
    expect(events).toContain("TeamDissolved")
    expect(events).toContain("EngineerSpawned")
    expect(events).toContain("EngineerCompleted")
    expect(events).toContain("EngineerFailed")
    expect(events).toContain("EngineerProgress")
    expect(events).toContain("TaskAssigned")
    expect(events).toContain("TaskUpdated")
    expect(events).toContain("TaskCompleted")
  })
})

describe("publishTeamEvent plugin trigger (O2)", () => {
  // Capture notifyPluginEvent calls by spying on the module export.
  // We use a module-level recorded array populated via _registerHooksGetter.
  const recorded: Array<{ type: string; properties: unknown }> = []

  beforeEach(() => {
    recorded.length = 0
    // Reset all getters so each test starts clean
    PluginModule._clearHooksGetters()
    // Register a test hooks getter that captures event calls
    PluginModule._registerHooksGetter(() => [
      {
        event: async ({ event }) => {
          recorded.push({ type: event.type, properties: (event as any).properties })
        },
      } satisfies Partial<Hooks> as Hooks,
    ])
  })

  test("publishTeamEvent calls plugin event hook with correct type and payload (team.created)", () => {
    const payload = { teamID: "t1", leadSessionID: "s1", goal: "do stuff" }
    publishTeamEvent(Event.TeamCreated, payload)
    // notifyPluginEvent is synchronous dispatch; wait a microtask for the promise
    return Promise.resolve().then(() => {
      expect(recorded.some((r) => r.type === "team.created")).toBe(true)
      const entry = recorded.find((r) => r.type === "team.created")!
      expect(entry.properties).toEqual(payload)
    })
  })

  test("all 9 team event types route to plugin event hook", async () => {
    publishTeamEvent(Event.TeamCreated, { teamID: "t1", leadSessionID: "s1", goal: "g" })
    publishTeamEvent(Event.TeamDissolved, { teamID: "t1", reason: "done" })
    publishTeamEvent(Event.EngineerSpawned, {
      teamID: "t1", engineerID: "e1", sessionID: "s1", name: "eng-1",
      state: "working", taskID: "task1", taskTitle: "t", taskDescription: "d",
    })
    publishTeamEvent(Event.EngineerCompleted, { teamID: "t1", engineerID: "e1", taskId: "task1" })
    publishTeamEvent(Event.EngineerFailed, { teamID: "t1", engineerID: "e1", taskId: "task1", error: "oops" })
    publishTeamEvent(Event.EngineerProgress, { teamID: "t1", engineerID: "e1", progressText: "doing", timestamp: 1 })
    publishTeamEvent(Event.TaskAssigned, { teamID: "t1", taskId: "task1", engineerID: "e1" })
    publishTeamEvent(Event.TaskUpdated, { teamID: "t1", taskId: "task1", status: "in-progress", oldStatus: "pending" })
    publishTeamEvent(Event.TaskCompleted, { teamID: "t1", taskId: "task1", engineerID: "e1" })

    await Promise.resolve()

    const types = recorded.map((r) => r.type)
    expect(types).toContain("team.created")
    expect(types).toContain("team.dissolved")
    expect(types).toContain("engineer.spawned")
    expect(types).toContain("engineer.completed")
    expect(types).toContain("engineer.failed")
    expect(types).toContain("engineer.progress")
    expect(types).toContain("task.assigned")
    expect(types).toContain("task.updated")
    expect(types).toContain("task.completed")
  })

  test("plugin hook failure does NOT prevent Bus/GlobalBus emissions", async () => {
    // Replace the capturing hook with a failing one
    PluginModule._clearHooksGetters()
    PluginModule._registerHooksGetter(() => [
      {
        event: async () => {
          throw new Error("plugin exploded")
        },
      } satisfies Partial<Hooks> as Hooks,
    ])

    let globalBusReceived = false
    const { GlobalBus } = await import("@/bus/global")
    const listener = (e: any) => {
      if (e.payload?.type === "team.dissolved") globalBusReceived = true
    }
    GlobalBus.on("event", listener)
    try {
      publishTeamEvent(Event.TeamDissolved, { teamID: "t2", reason: "test" })
      await new Promise((r) => setTimeout(r, 10))
      expect(globalBusReceived).toBe(true)
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  test("engineer subprocess (OPENCODE_TEAM_ENGINEER=1) does NOT call plugin event hook", async () => {
    const before = recorded.length
    process.env.OPENCODE_TEAM_ENGINEER = "1"
    try {
      publishTeamEvent(Event.TeamCreated, { teamID: "t3", leadSessionID: "s3", goal: "engineer only" })
      await Promise.resolve()
      // No new plugin notifications should have been added
      expect(recorded.length).toBe(before)
    } finally {
      delete process.env.OPENCODE_TEAM_ENGINEER
    }
  })
})
