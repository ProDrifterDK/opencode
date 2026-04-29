/**
 * Internal module: the nested `running` map and its helpers.
 * Kept separate so unit tests can import without pulling in
 * the full daemon (which triggers Effect app-runtime init).
 */
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "@/session/schema"
import type { KillableSubprocess } from "./engineer-process-manager"

export type RunningEngineer = {
  engineerID: string
  sessionID: SessionID
  teamID: string
  startedAt: number
  worktreePath: string
  branch: string
  /**
   * OS process ID of the engineer subprocess. Phase 1 of A3 replaces the
   * in-process Effect fiber with a `Bun.spawn`ed child — the lead now sees
   * each engineer as a real OS process, so a crashing/OOM engineer cannot
   * take down the lead.
   */
  pid: number
  /**
   * Handle to the spawned child process. Optional for tests that inject a
   * fake spawner — production always sets this. Phase 2 reads stdio from
   * this handle to forward engineer events back to the lead's bus;
   * Phase 3 wired `.exited` into crash detection via `attachExitHandler` in daemon.ts.
   */
  subprocess?: KillableSubprocess
  /**
   * Promise that resolves when the engineer's stdout JSONL reader has
   * fully drained. The exit handler awaits this BEFORE reconciling DB
   * state — otherwise a clean-exit engineer that published
   * `EngineerCompleted` to stdout right before exit can still be in
   * "working" state when reconcileExitedEngineer runs (the
   * EngineerCompleted line is buffered and not yet processed). Without
   * this guard, a successful engineer is misreported as failed and the
   * heartbeat sweep fires a spurious `all-engineers-failed` urgent.
   * Optional for tests.
   */
  eventReaderDone?: Promise<void>
  /**
   * Set by the lead daemon as soon as it observes an EngineerCompleted
   * event from this subprocess. The exit handler checks this synchronous
   * flag before consulting slower coordinator state so a clean
   * completed→exit(0) race cannot be reclassified as failed.
   */
  completedAt?: number
}

export const running = new Map<TeamID, Map<EngineerID, RunningEngineer>>()
const terminating = new Set<string>()

const terminatingKey = (teamID: TeamID, engineerID: EngineerID) => `${teamID}:${engineerID}`

export function getTeamBucket(teamID: TeamID): Map<EngineerID, RunningEngineer> {
  return running.get(teamID) ?? new Map()
}

export function getOrCreateTeamBucket(teamID: TeamID): Map<EngineerID, RunningEngineer> {
  let bucket = running.get(teamID)
  if (!bucket) {
    bucket = new Map()
    running.set(teamID, bucket)
  }
  return bucket
}

export function setRunning(teamID: TeamID, engineerID: EngineerID, value: RunningEngineer): void {
  getOrCreateTeamBucket(teamID).set(engineerID, value)
}

export function getRunningEngineer(teamID: TeamID, engineerID: EngineerID): RunningEngineer | undefined {
  return running.get(teamID)?.get(engineerID)
}

export function deleteRunning(teamID: TeamID, engineerID: EngineerID): void {
  const bucket = running.get(teamID)
  if (!bucket) return
  bucket.delete(engineerID)
  if (bucket.size === 0) running.delete(teamID)
}

export function* iterAllRunning(): Iterable<[TeamID, EngineerID, RunningEngineer]> {
  for (const [teamID, bucket] of running) {
    for (const [engineerID, eng] of bucket) {
      yield [teamID, engineerID, eng]
    }
  }
}

export function countAllRunning(): number {
  let total = 0
  for (const bucket of running.values()) total += bucket.size
  return total
}

export function markTerminating(teamID: TeamID, engineerID: EngineerID): boolean {
  const key = terminatingKey(teamID, engineerID)
  if (terminating.has(key)) return false
  terminating.add(key)
  return true
}

export function isTerminating(teamID: TeamID, engineerID: EngineerID): boolean {
  return terminating.has(terminatingKey(teamID, engineerID))
}

export function clearTerminating(teamID: TeamID, engineerID: EngineerID): void {
  terminating.delete(terminatingKey(teamID, engineerID))
}

export function clearAllTerminating(): void {
  terminating.clear()
}

export function terminateRunningEngineersForShutdown(
  terminate: (engineerID: string, pid: number, sub: KillableSubprocess | undefined) => void,
): number {
  const engineers = [...iterAllRunning()]
  for (const [, engineerID, engineer] of engineers) {
    terminate(engineerID as string, engineer.pid, engineer.subprocess)
  }
  return engineers.length
}
