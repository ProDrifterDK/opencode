/**
 * Unit tests for the TeamCommitTool execute logic (Phase 3: squash-merge semantics).
 *
 * We cannot import from `../tool/team` directly because that module
 * transitively imports `app-runtime.ts`, which has a circular-init
 * `ReferenceError` at module-evaluation time in the test environment.
 *
 * Instead we reproduce the exact execute body inline and supply the same
 * service contracts via Effect layers — matching the pattern used in
 * heartbeat.test.ts and lifecycle-integration.test.ts.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as SessionCoordinatorService } from "./session-coordinator"
import { Service as GitManagerService, MergeConflictError, GitError } from "./git-manager"
import { Service as TaskBoardService } from "./task-board"
import type { SessionID } from "../session/schema"
import type { TeamID, EngineerID } from "./types"
import type { EngineerSlot } from "./session-coordinator"
import type { TaskBoardID } from "./task-board.sql"

const LEAD_SESSION = "sess_lead" as SessionID
const OTHER_SESSION = "sess_other" as SessionID
const TEAM_ID = "team_001" as TeamID

// ─── Minimal service stubs ──────────────────────────────────────────────────

type EngineerRow = { engineerID: EngineerID; state: string; currentTask: string | null }
type TaskRow = { id: TaskBoardID; title: string; status: string; assigned_engineer_id: EngineerID | null; team_id: TeamID; dependencies: TaskBoardID[] }

const makeCoordinatorStub = (
  leadSessionID: SessionID,
  engineers: EngineerRow[] = [],
): InstanceType<typeof SessionCoordinatorService> =>
  SessionCoordinatorService.of({
    createTeam: () => Effect.die("not implemented"),
    spawnEngineer: () => Effect.die("not implemented"),
    resumeEngineer: () => Effect.die("not implemented"),
    killEngineer: () => Effect.die("not implemented"),
    dissolveTeam: () => Effect.die("not implemented"),
    getTeam: () => Effect.succeed(null),
    getEngineer: () => Effect.succeed(null),
    getEngineerBySession: () => Effect.succeed(null),
    listTeamEngineers: () => Effect.succeed(engineers as unknown as EngineerSlot[]),
    listTeams: () => Effect.succeed([]),
    isLead: (sessionID: SessionID) => Effect.succeed(sessionID === leadSessionID),
    isEngineer: () => Effect.succeed(false),
    updateEngineer: () => Effect.void,
    getTeamForSession: () => Effect.succeed(null),
  } as any)

const makeTaskBoardStub = (tasks: TaskRow[]) =>
  TaskBoardService.of({
    create: () => Effect.die("not implemented"),
    update: () => Effect.die("not implemented"),
    list: () => Effect.succeed(tasks as any),
    get: (id) => Effect.succeed(tasks.find((t) => t.id === id) ?? null as any),
    delete: () => Effect.die("not implemented"),
  })

type MergeCall = { teamID: TeamID; engineerID: EngineerID; message?: string }

const makeGitManagerStub = (
  mergeFn: (input: MergeCall) => Effect.Effect<void, GitError | MergeConflictError> = () => Effect.void,
) =>
  GitManagerService.of({
    createBranch: () => Effect.die("not implemented"),
    detectOverlap: () => Effect.die("not implemented"),
    commitWork: () => Effect.die("not implemented"),
    mergeBranch: mergeFn,
    cleanupBranches: () => Effect.die("not implemented"),
    getBranchStatus: () => Effect.die("not implemented"),
  })

// ─── The execute logic under test (mirrors TeamCommitTool exactly) ──────────

const teamCommitExecute = (params: { teamID: string }, sessionID: SessionID) =>
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinatorService
    const gitManager = yield* GitManagerService
    const taskBoard = yield* TaskBoardService

    const isLead = yield* coordinator.isLead(sessionID)
    if (!isLead) {
      return yield* Effect.fail(new Error("Only the lead can commit team work"))
    }

    const teamID = params.teamID as TeamID

    const allTasks = yield* taskBoard.list({ team_id: teamID })
    const completedTasks = (allTasks as unknown as TaskRow[]).filter(
      (t) => t.status === "completed" && t.assigned_engineer_id !== null,
    )

    const engineers = yield* coordinator.listTeamEngineers(teamID)

    const merged: { engineerID: string; taskTitle: string }[] = []
    const conflicts: { engineerID: string; branch: string; files: readonly string[] }[] = []
    const skipped: { engineerID: string; reason: string }[] = []

    for (const eng of engineers as unknown as EngineerRow[]) {
      if (eng.state !== "idle") {
        const stateLabel =
          eng.state === "working"
            ? "still running"
            : eng.state === "blocked"
              ? "blocked"
              : "failed"
        skipped.push({ engineerID: eng.engineerID, reason: stateLabel })
      }
    }

    for (const task of completedTasks) {
      const engineerID = task.assigned_engineer_id!

      const mergeResult = yield* gitManager
        .mergeBranch({
          teamID,
          engineerID: engineerID as EngineerID,
          message: task.title,
        })
        .pipe(
          Effect.map(() => ({ ok: true as const })),
          Effect.catchTag("MergeConflictError", (err) =>
            Effect.succeed({
              ok: false as const,
              branch: err.branch,
              files: err.conflictingFiles,
            }),
          ),
        )

      if (mergeResult.ok) {
        merged.push({ engineerID, taskTitle: task.title })
      } else {
        conflicts.push({ engineerID, branch: mergeResult.branch, files: mergeResult.files })
        break
      }
    }

    const lines: string[] = []

    if (merged.length === 0 && completedTasks.length === 0) {
      lines.push("No engineers with completed tasks to merge.")
    } else {
      lines.push(`Merged ${merged.length} engineer${merged.length === 1 ? "" : "s"} into current branch:`)
      for (const m of merged) {
        lines.push(`  ✓ ${m.engineerID} (task: "${m.taskTitle}")`)
      }
    }

    if (skipped.length > 0) {
      lines.push(`Skipped ${skipped.length}: ${skipped.map((s) => `${s.engineerID} (${s.reason})`).join(", ")}`)
    }

    if (conflicts.length > 0) {
      lines.push(`Conflicts ${conflicts.length}:`)
      for (const c of conflicts) {
        lines.push(`  ! ${c.engineerID} on branch ${c.branch}`)
        if (c.files.length > 0) {
          lines.push(`    Conflicting files: ${c.files.join(", ")}`)
        }
        lines.push(`    Resolve conflicts manually, then re-run team_commit.`)
      }
    } else {
      lines.push(`Conflicts 0`)
    }

    return {
      title: `Commit team ${params.teamID}`,
      output: lines.join("\n"),
      metadata: {
        teamID: params.teamID,
        merged: merged.map((m) => m.engineerID),
        conflicts: conflicts.map((c) => ({ engineerID: c.engineerID, branch: c.branch })),
        skipped: skipped.map((s) => s.engineerID),
      },
    }
  })

// ─── Test runner ─────────────────────────────────────────────────────────────

const runWith = (
  sessionID: SessionID,
  teamID: string,
  engineers: EngineerRow[],
  tasks: TaskRow[],
  mergeFn?: (input: MergeCall) => Effect.Effect<void, GitError | MergeConflictError>,
  leadSessionID: SessionID = LEAD_SESSION,
) => {
  const coordLayer = Layer.succeed(SessionCoordinatorService, makeCoordinatorStub(leadSessionID, engineers))
  const gitLayer = Layer.succeed(GitManagerService, makeGitManagerStub(mergeFn))
  const taskLayer = Layer.succeed(TaskBoardService, makeTaskBoardStub(tasks))
  const testLayer = Layer.merge(Layer.merge(coordLayer, gitLayer), taskLayer)
  return Effect.provide(teamCommitExecute({ teamID }, sessionID), testLayer).pipe(
    Effect.runPromise,
  )
}

// ─── Test data helpers ────────────────────────────────────────────────────────

const eng = (id: string, state: string): EngineerRow => ({
  engineerID: id as EngineerID,
  state,
  currentTask: null,
})

const task = (id: string, title: string, engineerID: string, status = "completed"): TaskRow => ({
  id: id as TaskBoardID,
  title,
  status,
  assigned_engineer_id: engineerID as EngineerID,
  team_id: TEAM_ID,
  dependencies: [],
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TeamCommitTool execute (Phase 3: squash-merge)", () => {
  // 1. Happy path: 3 completed engineers, all merged
  test("happy path: merges all completed engineers with correct task titles", async () => {
    const engineers = [eng("eng-a", "idle"), eng("eng-b", "idle"), eng("eng-c", "idle")]
    const tasks = [
      task("t1", "Refactor auth middleware", "eng-a"),
      task("t2", "Add DAG tests", "eng-b"),
      task("t3", "Wire HeartbeatMonitor", "eng-c"),
    ]
    const calls: MergeCall[] = []
    const result = await runWith(
      LEAD_SESSION, TEAM_ID, engineers, tasks,
      (input) => Effect.sync(() => { calls.push(input) }),
    )

    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ engineerID: "eng-a", message: "Refactor auth middleware" })
    expect(calls[1]).toMatchObject({ engineerID: "eng-b", message: "Add DAG tests" })
    expect(calls[2]).toMatchObject({ engineerID: "eng-c", message: "Wire HeartbeatMonitor" })

    expect(result.metadata.merged).toEqual(["eng-a", "eng-b", "eng-c"])
    expect(result.metadata.conflicts).toHaveLength(0)
    expect(result.metadata.skipped).toHaveLength(0)
    expect(result.output).toContain("Merged 3 engineers")
    expect(result.output).toContain('"Refactor auth middleware"')
    expect(result.output).toContain("Conflicts 0")
  })

  // 2. Mixed states: only completed (idle) engineers are merged; running/failed are skipped
  test("mixed states: only idle engineers' tasks are merged; others reported as skipped", async () => {
    const engineers = [
      eng("eng-a", "idle"),
      eng("eng-b", "working"),
      eng("eng-c", "failed"),
      eng("eng-d", "idle"),
    ]
    const tasks = [
      task("t1", "Completed task A", "eng-a"),
      task("t2", "In-progress task B", "eng-b", "in-progress"),
      task("t3", "Completed task D", "eng-d"),
    ]
    const calls: MergeCall[] = []
    const result = await runWith(
      LEAD_SESSION, TEAM_ID, engineers, tasks,
      (input) => Effect.sync(() => { calls.push(input) }),
    )

    // Only completed tasks are merged
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.engineerID as string)).toEqual(["eng-a", "eng-d"])

    expect(result.metadata.merged).toEqual(["eng-a", "eng-d"])
    expect(result.metadata.skipped).toContain("eng-b")
    expect(result.metadata.skipped).toContain("eng-c")
    expect(result.output).toContain("Skipped 2")
    expect(result.output).toContain("still running")
    expect(result.output).toContain("failed")
  })

  // 3. Conflict path: stops on first conflict, engineer 3 not merged
  test("conflict path: stops at first conflict and reports it; remaining engineers not merged", async () => {
    const engineers = [eng("eng-a", "idle"), eng("eng-b", "idle"), eng("eng-c", "idle")]
    const tasks = [
      task("t1", "Task A", "eng-a"),
      task("t2", "Task B — conflicts", "eng-b"),
      task("t3", "Task C", "eng-c"),
    ]
    const calls: MergeCall[] = []
    const result = await runWith(
      LEAD_SESSION, TEAM_ID, engineers, tasks,
      (input) =>
        Effect.sync(() => { calls.push(input) }).pipe(
          Effect.flatMap(() => {
            if (input.engineerID === "eng-b") {
              return Effect.fail(new MergeConflictError({
                message: "conflict",
                branch: "team/team_001/engineer-eng-b",
                conflictingFiles: ["src/foo.ts"],
              }))
            }
            return Effect.void
          }),
        ),
    )

    // eng-a merged, eng-b conflicted, eng-c never attempted
    expect(calls).toHaveLength(2)
    expect(result.metadata.merged).toEqual(["eng-a"])
    expect(result.metadata.conflicts).toHaveLength(1)
    expect(result.metadata.conflicts[0].engineerID).toBe("eng-b")
    expect(result.output).toContain("Conflicts 1")
    expect(result.output).toContain("src/foo.ts")
    expect(result.output).toContain("Resolve conflicts manually")
    // eng-c should not appear in merged
    expect(result.metadata.merged).not.toContain("eng-c")
  })

  // 4. Lead-only: non-lead session fails
  test("lead-only: non-lead session fails with expected error message", async () => {
    await expect(
      runWith(OTHER_SESSION, TEAM_ID, [], []),
    ).rejects.toThrow("Only the lead can commit team work")
  })

  // 5. No completed engineers: returns polite summary, no errors
  test("no completed engineers: returns polite summary with no merge calls", async () => {
    const engineers = [eng("eng-a", "working"), eng("eng-b", "blocked")]
    const tasks = [
      task("t1", "Running task", "eng-a", "in-progress"),
    ]
    const calls: MergeCall[] = []
    const result = await runWith(
      LEAD_SESSION, TEAM_ID, engineers, tasks,
      (input) => Effect.sync(() => { calls.push(input) }),
    )

    expect(calls).toHaveLength(0)
    expect(result.output).toContain("No engineers with completed tasks to merge.")
    expect(result.metadata.merged).toHaveLength(0)
    expect(result.metadata.conflicts).toHaveLength(0)
  })
})
