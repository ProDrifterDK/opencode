/**
 * Internal module: the nested `running` map and its helpers.
 * Kept separate so unit tests can import without pulling in
 * the full daemon (which triggers Effect app-runtime init).
 */
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "@/session/schema"

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
   * fake spawner — production always sets this. Phase 2 will read stdio
   * from this handle to forward engineer events back to the lead's bus,
   * Phase 3 will wire `.exited` into crash detection.
   */
  subprocess?: import("bun").Subprocess
}

export const running = new Map<TeamID, Map<EngineerID, RunningEngineer>>()

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
