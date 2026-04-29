import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import {
  running,
  setRunning,
  getRunningEngineer,
  deleteRunning,
  iterAllRunning,
  countAllRunning,
  terminateRunningEngineersForShutdown,
  markTerminating,
  isTerminating,
  clearTerminating,
  clearAllTerminating,
} from "./daemon-running"
import { Service as ProcessManagerService, type KillableSubprocess, type SpawnInput } from "./engineer-process-manager"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "@/session/schema"

const TEAM_A = "team_a" as TeamID
const TEAM_B = "team_b" as TeamID
const ENG_A1 = "eng_a1" as EngineerID
const ENG_A2 = "eng_a2" as EngineerID
const ENG_B1 = "eng_b1" as EngineerID

let pidCounter = 1000
const makeEntry = (teamID: TeamID, engineerID: EngineerID) => ({
  engineerID,
  sessionID: `session-${engineerID}` as SessionID,
  teamID,
  startedAt: Date.now(),
  worktreePath: `/tmp/worktrees/${teamID}/${engineerID}`,
  branch: `team/${teamID}/engineer-${engineerID}`,
  pid: pidCounter++,
  // subprocess intentionally omitted — tests don't need a real handle
})

beforeEach(() => {
  running.clear()
  clearAllTerminating()
})

describe("nested running map helpers", () => {
  test("setRunning creates a team bucket and stores the engineer", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    expect(running.has(TEAM_A)).toBe(true)
    expect(running.get(TEAM_A)?.has(ENG_A1)).toBe(true)
    expect(countAllRunning()).toBe(1)
  })

  test("killing engineer in team A leaves team B untouched", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_A, ENG_A2, makeEntry(TEAM_A, ENG_A2))
    setRunning(TEAM_B, ENG_B1, makeEntry(TEAM_B, ENG_B1))

    expect(countAllRunning()).toBe(3)

    deleteRunning(TEAM_A, ENG_A1)

    // Team A still has ENG_A2
    expect(running.has(TEAM_A)).toBe(true)
    expect(running.get(TEAM_A)?.has(ENG_A1)).toBe(false)
    expect(running.get(TEAM_A)?.has(ENG_A2)).toBe(true)

    // Team B is completely untouched
    expect(running.has(TEAM_B)).toBe(true)
    expect(running.get(TEAM_B)?.has(ENG_B1)).toBe(true)

    expect(countAllRunning()).toBe(2)
  })

  test("empty team bucket is removed when last engineer exits", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_B, ENG_B1, makeEntry(TEAM_B, ENG_B1))

    expect(running.size).toBe(2) // 2 teams

    deleteRunning(TEAM_A, ENG_A1)

    // Team A bucket removed since it's empty
    expect(running.has(TEAM_A)).toBe(false)
    expect(running.size).toBe(1) // only TEAM_B remains

    // Team B still intact
    expect(running.get(TEAM_B)?.has(ENG_B1)).toBe(true)
  })

  test("iterAllRunning yields all engineers across all teams", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_A, ENG_A2, makeEntry(TEAM_A, ENG_A2))
    setRunning(TEAM_B, ENG_B1, makeEntry(TEAM_B, ENG_B1))

    const all = [...iterAllRunning()]
    expect(all).toHaveLength(3)

    const teamAEntries = all.filter(([t]) => t === TEAM_A)
    const teamBEntries = all.filter(([t]) => t === TEAM_B)
    expect(teamAEntries).toHaveLength(2)
    expect(teamBEntries).toHaveLength(1)
  })

  test("getRunningEngineer returns undefined for wrong teamID", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    // Looking up ENG_A1 under TEAM_B should return undefined
    expect(getRunningEngineer(TEAM_B, ENG_A1)).toBeUndefined()
    // Looking up under correct team works
    expect(getRunningEngineer(TEAM_A, ENG_A1)).toBeDefined()
  })
})

describe("Phase 2: RunningEngineer carries worktree metadata", () => {
  test("RunningEngineer stores worktreePath and branch", () => {
    const entry = makeEntry(TEAM_A, ENG_A1)
    setRunning(TEAM_A, ENG_A1, entry)

    const found = getRunningEngineer(TEAM_A, ENG_A1)
    expect(found).toBeDefined()
    expect(found!.worktreePath).toBe(`/tmp/worktrees/${TEAM_A}/${ENG_A1}`)
    expect(found!.branch).toBe(`team/${TEAM_A}/engineer-${ENG_A1}`)
  })

  test("worktreePath and branch survive deleteRunning for other engineers", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_A, ENG_A2, makeEntry(TEAM_A, ENG_A2))

    deleteRunning(TEAM_A, ENG_A2)

    const remaining = getRunningEngineer(TEAM_A, ENG_A1)
    expect(remaining).toBeDefined()
    // worktreePath and branch are still intact on ENG_A1 after ENG_A2 is removed
    expect(remaining!.worktreePath).toBe(`/tmp/worktrees/${TEAM_A}/${ENG_A1}`)
    expect(remaining!.branch).toBe(`team/${TEAM_A}/engineer-${ENG_A1}`)
    // ENG_A2's slot is gone but no worktree removal happens here (Phase 3 / team_dissolve cleans up)
    expect(getRunningEngineer(TEAM_A, ENG_A2)).toBeUndefined()
  })
})

describe("Phase 3 (A3): RunningEngineer carries subprocess pid", () => {
  // The previous fiber model is gone — engineers are now OS subprocesses
  // launched via EngineerProcessManager (Phase 1 of A3). The `pid` is the
  // load-bearing handle; Phase 2 will read its stdio and Phase 3 will
  // wire .exited for crash detection.

  test("RunningEngineer stores a numeric pid", () => {
    const entry = makeEntry(TEAM_A, ENG_A1)
    setRunning(TEAM_A, ENG_A1, entry)

    const found = getRunningEngineer(TEAM_A, ENG_A1)
    expect(found).toBeDefined()
    expect(typeof found!.pid).toBe("number")
    expect(found!.pid).toBeGreaterThan(0)
  })

  test("each engineer gets a distinct pid", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_A, ENG_A2, makeEntry(TEAM_A, ENG_A2))

    const a1 = getRunningEngineer(TEAM_A, ENG_A1)
    const a2 = getRunningEngineer(TEAM_A, ENG_A2)
    expect(a1).toBeDefined()
    expect(a2).toBeDefined()
    expect(a1!.pid).not.toBe(a2!.pid)
  })
})

describe("graceful shutdown subprocess cleanup", () => {
  test("terminates tracked engineers without clearing the running map first", () => {
    setRunning(TEAM_A, ENG_A1, makeEntry(TEAM_A, ENG_A1))
    setRunning(TEAM_A, ENG_A2, makeEntry(TEAM_A, ENG_A2))

    const terminated: Array<{ engineerID: string; pid: number }> = []
    const count = terminateRunningEngineersForShutdown((engineerID, pid) => {
      terminated.push({ engineerID, pid })
    })

    expect(count).toBe(2)
    expect(terminated).toHaveLength(2)
    expect(terminated.map((entry) => entry.engineerID).sort()).toEqual([ENG_A1, ENG_A2].sort())
    expect(countAllRunning()).toBe(2)
    expect(getRunningEngineer(TEAM_A, ENG_A1)).toBeDefined()
    expect(getRunningEngineer(TEAM_A, ENG_A2)).toBeDefined()
  })
})

describe("termination dedupe helpers", () => {
  test("markTerminating only succeeds once per engineer until cleared", () => {
    expect(markTerminating(TEAM_A, ENG_A1)).toBe(true)
    expect(markTerminating(TEAM_A, ENG_A1)).toBe(false)
    expect(isTerminating(TEAM_A, ENG_A1)).toBe(true)

    clearTerminating(TEAM_A, ENG_A1)

    expect(isTerminating(TEAM_A, ENG_A1)).toBe(false)
    expect(markTerminating(TEAM_A, ENG_A1)).toBe(true)
  })
})

describe("Phase 1 of A3: EngineerProcessManager spawn path", () => {
  // We exercise the spawn service through a fake layer so the test
  // doesn't actually fork bun. The real layer uses Bun.spawn; tests
  // need only confirm that spawn is wired with the right inputs and
  // that callers receive a {pid, subprocess} pair.

  test("spawn is invoked with the lead's teamID/engineerID/worktreePath", async () => {
    let captured: SpawnInput | undefined
    const subprocess: KillableSubprocess = {
      exited: Promise.resolve(0),
      kill: () => {},
    }
    const fakeProcessManager = ProcessManagerService.of({
      spawn: (input) => {
        captured = input
        return Effect.succeed({
          pid: 4242,
          subprocess,
          eventReaderDone: Promise.resolve(),
        })
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ProcessManagerService
        return yield* svc.spawn({
          teamID: TEAM_A,
          engineerID: ENG_A1,
          sessionID: "ses_x",
          worktreePath: "/tmp/wt/team_a/eng_a1",
          name: "alice",
          taskID: "task_1",
          taskTitle: "do thing",
          taskDescription: "the thing",
          providerID: "anthropic",
          modelID: "claude-3",
        })
      }).pipe(Effect.provide(Layer.succeed(ProcessManagerService, fakeProcessManager))),
    )

    expect(captured).toBeDefined()
    if (!captured) throw new Error("spawn input was not captured")
    expect(captured.teamID).toBe(TEAM_A)
    expect(captured.engineerID).toBe(ENG_A1)
    expect(captured.worktreePath).toBe("/tmp/wt/team_a/eng_a1")
    expect(captured.name).toBe("alice")
    expect(captured.taskID).toBe("task_1")
    expect(result.pid).toBe(4242)
  })

  test("the resulting RunningEngineer carries a pid sourced from spawn", () => {
    // Simulate what daemon.startEngineerInBackground does after a
    // successful spawn: it stores the pid on the running map.
    const spawnedPid = 9999
    setRunning(TEAM_A, ENG_A1, {
      engineerID: ENG_A1 as string,
      sessionID: `session-${ENG_A1}` as SessionID,
      teamID: TEAM_A,
      startedAt: Date.now(),
      worktreePath: `/tmp/wt/${TEAM_A}/${ENG_A1}`,
      branch: `team/${TEAM_A}/engineer-${ENG_A1}`,
      pid: spawnedPid,
    })

    const found = getRunningEngineer(TEAM_A, ENG_A1)
    expect(found).toBeDefined()
    expect(found!.pid).toBe(spawnedPid)
  })
})
