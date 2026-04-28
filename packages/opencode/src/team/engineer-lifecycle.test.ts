/**
 * Phase 3 of A3 — engineer subprocess lifecycle.
 *
 * These tests focus on the graceful-kill helper (`terminateSubprocess`)
 * which is the new primitive that Phase 3 introduces. The centralized
 * exit handler in `daemon.ts` chains the same `subprocess.exited`
 * promise this helper waits on, so verifying the helper's behavior
 * (SIGTERM-first, escalate on timeout, idempotent on already-exited)
 * locks in the contract every other path depends on.
 */
import { describe, test, expect } from "bun:test"
import { terminateSubprocess, type KillableSubprocess } from "./engineer-process-manager"
import { reconcileExitedEngineer } from "./engineer-lifecycle"

/**
 * Minimal in-memory fake of Bun.Subprocess that records signals and
 * lets the test resolve `.exited` on demand.
 */
function makeFakeSubprocess() {
  let resolveExited: (code: number | null | undefined) => void = () => {}
  const exited = new Promise<number | null | undefined>((res) => {
    resolveExited = res
  })

  const signals: string[] = []
  let exitCode: number | null | undefined = undefined

  const sub: KillableSubprocess & {
    signals: string[]
    resolveExit: (code: number | null) => void
    isAlive: () => boolean
  } = {
    get exited() {
      return exited
    },
    get exitCode() {
      return exitCode
    },
    kill(signal?: number | NodeJS.Signals | string) {
      signals.push(typeof signal === "string" ? signal : String(signal ?? "default"))
    },
    signals,
    resolveExit(code: number | null) {
      exitCode = code
      resolveExited(code)
    },
    isAlive() {
      return exitCode === undefined
    },
  }

  return sub
}

describe("terminateSubprocess (Phase 3 graceful kill)", () => {
  test("sends SIGTERM and returns the exit code when child exits in time", async () => {
    const sub = makeFakeSubprocess()
    const promise = terminateSubprocess(sub, { timeoutMs: 1_000 })

    // Child cooperates immediately.
    sub.resolveExit(0)

    const code = await promise
    expect(code).toBe(0)
    expect(sub.signals).toEqual(["SIGTERM"])
  })

  test("escalates to SIGKILL when child does not exit before timeout", async () => {
    const sub = makeFakeSubprocess()
    const promise = terminateSubprocess(sub, { timeoutMs: 30 })

    // Don't resolve right away — let the timeout fire.
    await new Promise((r) => setTimeout(r, 60))

    // After SIGKILL the child eventually exits.
    sub.resolveExit(null)

    await promise
    expect(sub.signals[0]).toBe("SIGTERM")
    expect(sub.signals[1]).toBe("SIGKILL")
    expect(sub.signals.length).toBe(2)
  })

  test("returns immediately when subprocess has already exited", async () => {
    const sub = makeFakeSubprocess()
    sub.resolveExit(0) // pre-exit

    const code = await terminateSubprocess(sub, { timeoutMs: 1_000 })
    expect(code).toBe(0)
    // No signals should have been sent — child was already dead.
    expect(sub.signals).toEqual([])
  })

  test("idempotency: re-entering after exit is a no-op", async () => {
    const sub = makeFakeSubprocess()
    const first = terminateSubprocess(sub, { timeoutMs: 1_000 })
    sub.resolveExit(0)
    await first

    // A second call (simulating terminateEngineer racing the exit
    // handler) should not crash and should not send another signal.
    const second = await terminateSubprocess(sub, { timeoutMs: 1_000 })
    expect(second).toBe(0)
    expect(sub.signals).toEqual(["SIGTERM"])
  })

  test("swallows errors from kill() so a dead child doesn't crash callers", async () => {
    const sub = makeFakeSubprocess()
    sub.kill = () => {
      throw new Error("ESRCH no such process")
    }
    const promise = terminateSubprocess(sub, { timeoutMs: 30 })

    // After SIGTERM throws, the helper still falls into the timeout
    // path and tries SIGKILL, which also throws. Both are swallowed.
    await new Promise((r) => setTimeout(r, 60))
    sub.resolveExit(null)

    await expect(promise).resolves.toBeDefined()
  })
})

describe("reconcileExitedEngineer", () => {
  const fakeSlot = {
    engineerID: "eng_e",
    sessionID: "ses_x" as any,
    teamID: "team_t",
    startedAt: Date.now(),
    worktreePath: "/tmp/wt",
    branch: "team/t/e",
    pid: 1234,
  }

  test("slot gone → noop", () => {
    const action = reconcileExitedEngineer({ slot: undefined, currentState: undefined, code: 0 })
    expect(action).toEqual({ kind: "noop" })
  })

  test("slot present, state completed → delete", () => {
    const action = reconcileExitedEngineer({ slot: fakeSlot, currentState: "failed", code: 0 })
    expect(action).toEqual({ kind: "delete" })
  })

  test("slot present, completion event seen but state still working → delete", () => {
    const action = reconcileExitedEngineer({
      slot: fakeSlot,
      currentState: "working",
      code: 0,
      completedEventSeen: true,
    })
    expect(action).toEqual({ kind: "delete" })
  })

  test("slot present, state working, code 0 → delete-and-fail", () => {
    const action = reconcileExitedEngineer({ slot: fakeSlot, currentState: "working", code: 0 })
    expect(action).toEqual({ kind: "delete-and-fail", reason: "subprocess exited with code 0", code: 0 })
  })

  test("slot present, state working, code 137 (SIGKILL) → delete-and-fail", () => {
    const action = reconcileExitedEngineer({ slot: fakeSlot, currentState: "working", code: 137 })
    expect(action).toEqual({ kind: "delete-and-fail", reason: "subprocess exited with code 137", code: 137 })
  })
})

describe("centralized exit handler — race semantics", () => {
  // The exit handler attached in daemon.ts keys off
  // `getRunningEngineer` to detect "already cleaned up". This test
  // pins down that contract: once the slot is gone, a second exit
  // notification must do nothing. The full handler involves the Effect
  // app-runtime (coordinator, AppRuntime) which is out-of-scope for a
  // unit test — but verifying the slot-presence guard is the
  // load-bearing piece for race safety.

  test("getRunningEngineer + deleteRunning give a single-cleanup contract", async () => {
    const { running, setRunning, getRunningEngineer, deleteRunning } = await import("./daemon-running")
    running.clear()
    const teamID = "team_t" as any
    const engineerID = "eng_e" as any

    setRunning(teamID, engineerID, {
      engineerID: engineerID as string,
      sessionID: "ses_x" as any,
      teamID: teamID as string,
      startedAt: Date.now(),
      worktreePath: "/tmp/wt",
      branch: "team/t/e",
      pid: 1234,
    })

    // First exit: slot present → would clean up.
    expect(getRunningEngineer(teamID, engineerID)).toBeDefined()
    deleteRunning(teamID, engineerID)

    // Second exit (simulating racing terminateEngineer + .exited):
    // slot is gone → handler must short-circuit.
    expect(getRunningEngineer(teamID, engineerID)).toBeUndefined()
  })
})
