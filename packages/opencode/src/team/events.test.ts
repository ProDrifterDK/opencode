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
    expect(payloads.length).toBeGreaterThanOrEqual(8)
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

  test("EngineerSpawned accepts nullable taskId", () => {
    const props = Event.EngineerSpawned.properties
    const withNull = props.safeParse({
      teamID: "team_1",
      engineerID: "eng_1",
      name: "engineer-1",
      taskId: null,
    })
    expect(withNull.success).toBe(true)

    const withTask = props.safeParse({
      teamID: "team_1",
      engineerID: "eng_1",
      name: "engineer-1",
      taskId: "task_1",
    })
    expect(withTask.success).toBe(true)
  })

  test("publishTeamEvent and subscribeTeamEvent are callable functions", () => {
    expect(typeof publishTeamEvent).toBe("function")
    expect(typeof subscribeTeamEvent).toBe("function")
  })

  test("Event object has all 8 event types", () => {
    const events = Object.keys(Event)
    expect(events).toHaveLength(8)
    expect(events).toContain("TeamCreated")
    expect(events).toContain("TeamDissolved")
    expect(events).toContain("EngineerSpawned")
    expect(events).toContain("EngineerCompleted")
    expect(events).toContain("EngineerFailed")
    expect(events).toContain("TaskAssigned")
    expect(events).toContain("TaskUpdated")
    expect(events).toContain("TaskCompleted")
  })
})
