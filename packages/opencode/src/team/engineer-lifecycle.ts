/**
 * Pure reconciliation logic for engineer subprocess exit events.
 *
 * Kept separate from daemon.ts so it can be unit-tested without pulling
 * in Effect, AppRuntime, or the session-coordinator. The caller
 * (`attachExitHandler` in daemon.ts) reads the running-map slot and the
 * coordinator DB state, then delegates to this function to decide what
 * action to take.
 */
import type { RunningEngineer } from "./daemon-running"
import type { EngineerState } from "./types"

export type ReconcileAction =
  | { kind: "noop" }
  | { kind: "delete" }
  | { kind: "delete-and-fail"; reason: string; code: number | null }

/**
 * Given the running-map slot and the engineer's current DB state,
 * decide what cleanup action is needed after the subprocess exits.
 *
 * - If the slot is absent the handler already ran (race), do nothing.
 * - If the lead already observed EngineerCompleted for this slot, the
 *   process finished cleanly even if coordinator state has not caught up.
 * - If state is not "working" the engineer loop finished cleanly before
 *   the exit promise resolved — just remove the slot.
 * - If state is still "working" the process crashed before the engineer
 *   loop could mark itself terminal — remove the slot AND mark failed.
 */
export function reconcileExitedEngineer(input: {
  slot: RunningEngineer | undefined
  currentState: EngineerState | undefined
  code: number | null
  completedEventSeen?: boolean
}): ReconcileAction {
  if (!input.slot) return { kind: "noop" }
  if (input.completedEventSeen) return { kind: "delete" }
  if (input.currentState !== "working") return { kind: "delete" }
  return {
    kind: "delete-and-fail",
    reason: `subprocess exited with code ${input.code ?? "null"}`,
    code: input.code,
  }
}
