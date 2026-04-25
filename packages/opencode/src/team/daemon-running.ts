/**
 * Internal module: the nested `running` map and its helpers.
 * Kept separate so unit tests can import without pulling in
 * the full daemon (which triggers Effect app-runtime init).
 */
import { Fiber } from "effect"
import type { EngineerID, TeamID } from "./types"
import type { SessionID } from "@/session/schema"

export type RunningEngineer = {
  engineerID: string
  sessionID: SessionID
  teamID: string
  fiber: Fiber.RuntimeFiber<any, any>
  startedAt: number
  worktreePath: string
  branch: string
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
