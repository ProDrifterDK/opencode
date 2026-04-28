import { describe, expect, test } from "bun:test"
import { completionKey, rememberCompletion } from "./completion-deduper"

describe("completion deduper", () => {
  test("builds stable completion keys", () => {
    expect(completionKey({
      teamID: "team_1",
      engineerID: "eng_1",
      taskID: "task_1",
    })).toBe("team_1:eng_1:task_1")
  })

  test("detects duplicate completion events for the same engineer task", () => {
    const seen = new Set<string>()
    const input = { teamID: "team_1", engineerID: "eng_1", taskID: "task_1" }

    expect(rememberCompletion(seen, input)).toEqual({ kind: "new", key: "team_1:eng_1:task_1" })
    expect(rememberCompletion(seen, input)).toEqual({ kind: "duplicate", key: "team_1:eng_1:task_1" })
    expect(rememberCompletion(seen, { ...input, taskID: "task_2" })).toEqual({ kind: "new", key: "team_1:eng_1:task_2" })
  })
})
