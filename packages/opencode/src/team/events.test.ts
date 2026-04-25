import { describe, test, expect } from "bun:test"
import { BusEvent } from "@/bus/bus-event"
import { Event, publishTeamEvent, subscribeTeamEvent } from "./events"

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
    const parsed = teamCreatedProps.safeParse({
      teamID: "team_123",
      leadSessionID: "sess_456",
      goal: "implement auth",
    })
    expect(parsed.success).toBe(true)

    const engineerFailedProps = Event.EngineerFailed.properties
    const parsed2 = engineerFailedProps.safeParse({
      teamID: "team_x",
      engineerID: "eng_bad",
      taskId: "task_1",
      error: "timeout exceeded",
    })
    expect(parsed2.success).toBe(true)

    const taskUpdatedProps = Event.TaskUpdated.properties
    const parsed3 = taskUpdatedProps.safeParse({
      teamID: "team_z",
      taskId: "task_3",
      status: "in-progress",
      oldStatus: "pending",
    })
    expect(parsed3.success).toBe(true)
  })

  test("Event payloads reject invalid data", () => {
    const teamCreatedProps = Event.TeamCreated.properties
    const parsed = teamCreatedProps.safeParse({
      teamID: 123,
    })
    expect(parsed.success).toBe(false)
  })

  test("EngineerSpawned requires concrete task details", () => {
    // The schema evolved: every spawn now carries a concrete task
    // (see tool/team.ts team_spawn — taskID is always task.id, never
    // null). The earlier "nullable taskId" contract is gone.
    const props = Event.EngineerSpawned.properties

    const complete = props.safeParse({
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
    const withOptional = props.safeParse({
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
    const missingTask = props.safeParse({
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
