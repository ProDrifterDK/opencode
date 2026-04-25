import { describe, test, expect, beforeEach } from "bun:test"
import {
  running,
  setRunning,
  getRunningEngineer,
  deleteRunning,
  iterAllRunning,
  countAllRunning,
} from "./daemon-running"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "@/session/schema"

const TEAM_A = "team_a" as TeamID
const TEAM_B = "team_b" as TeamID
const ENG_A1 = "eng_a1" as EngineerID
const ENG_A2 = "eng_a2" as EngineerID
const ENG_B1 = "eng_b1" as EngineerID

const makeFakeFiber = () => ({ _tag: "RuntimeFiber" }) as any

const makeEntry = (teamID: TeamID, engineerID: EngineerID) => ({
  engineerID,
  sessionID: `session-${engineerID}` as SessionID,
  teamID,
  fiber: makeFakeFiber(),
  startedAt: Date.now(),
  worktreePath: `/tmp/worktrees/${teamID}/${engineerID}`,
  branch: `team/${teamID}/engineer-${engineerID}`,
})

beforeEach(() => {
  running.clear()
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
