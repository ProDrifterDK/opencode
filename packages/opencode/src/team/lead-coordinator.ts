import { Effect, Layer, Context, Schema } from "effect"
import { TaskBoardRepo, TaskBoardRepoError } from "./task-board"
import { type EngineerID, type EngineerStateRecord } from "./types"
import { MAX_TEAM_SIZE, TASK_BOARD_MAX_TASKS } from "./constants"
import { Event, publishTeamEvent } from "./events"
import type {
  Task,
  TaskBoardID,
  TeamID,
} from "./task-board.sql"

export class LeadCoordinatorError extends Schema.TaggedErrorClass<LeadCoordinatorError>()(
  "LeadCoordinatorError",
  { message: Schema.String },
) {}

export class FileScopeConflictError extends Schema.TaggedErrorClass<FileScopeConflictError>()(
  "FileScopeConflictError",
  { message: Schema.String, conflictingFiles: Schema.Array(Schema.String) },
) {}

export interface SubtaskSpec {
  title: string
  description: string
  files: string[]
}

export interface DecomposeInput {
  teamId: TeamID
  request: string
  subtasks: SubtaskSpec[]
}

export interface AssignInput {
  teamId: TeamID
  engineers: EngineerStateRecord[]
}

export interface ReassignInput {
  taskId: TaskBoardID
  toEngineer: EngineerID
}

export interface EngineerSummary {
  id: EngineerID
  state: EngineerStateRecord["state"]
  currentTask: string | null
}

export interface ProgressReport {
  totalTasks: number
  pending: number
  inProgress: number
  completed: number
  failed: number
  blocked: number
  engineers: EngineerSummary[]
  blockers: Task[]
}

const encodeFiles = (files: string[]): string => JSON.stringify(files)

const decodeFiles = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const filesOverlap = (a: string[], b: string[]): string[] =>
  a.filter((f) => b.includes(f))


type Err = LeadCoordinatorError | FileScopeConflictError | TaskBoardRepoError

export interface Interface {
  readonly decompose: (
    input: DecomposeInput,
  ) => Effect.Effect<Task[], Err>
  readonly assign: (
    input: AssignInput,
  ) => Effect.Effect<Task[], Err>
  readonly monitor: (
    teamId: TeamID,
  ) => Effect.Effect<ProgressReport, Err>
  readonly reassign: (
    input: ReassignInput,
  ) => Effect.Effect<Task, Err>
  readonly validateFileScopes: (
    tasks: Array<{ id: string; files: string[] }>,
  ) => Effect.Effect<boolean, never>
  readonly formatStatus: (report: ProgressReport) => string
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/LeadCoordinator",
) {}

export const layer: Layer.Layer<Service, never, TaskBoardRepo.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const taskBoard = yield* TaskBoardRepo.Service

    const decompose = Effect.fn("LeadCoordinator.decompose")(
      function* (input: DecomposeInput) {
        const specs = input.subtasks
        const allFiles: string[] = []
        for (const spec of specs) {
          const overlap = filesOverlap(spec.files, allFiles)
          if (overlap.length > 0) {
            yield* new FileScopeConflictError({
              message: `Subtask "${spec.title}" has file conflicts`,
              conflictingFiles: overlap,
            })
          }
          allFiles.push(...spec.files)
        }

        const existing = yield* taskBoard.list({ team_id: input.teamId })
        if (existing.length + specs.length > TASK_BOARD_MAX_TASKS) {
          yield* new LeadCoordinatorError({
            message: `Task board full (${existing.length}/${TASK_BOARD_MAX_TASKS})`,
          })
        }

        const created: Task[] = []
        for (const spec of specs) {
          const task = yield* taskBoard.create({
            team_id: input.teamId,
            title: spec.title,
            description: spec.description,
            file_scope: spec.files.length > 0 ? encodeFiles(spec.files) : null,
            status: "pending",
          })
          created.push(task)
        }

        void publishTeamEvent(Event.TeamCreated, {
          teamID: input.teamId,
          leadSessionID: input.teamId,
          goal: input.request,
        })

        return created
      },
    )

    const assign = Effect.fn("LeadCoordinator.assign")(
      function* (input: AssignInput) {
        const allTasks = yield* taskBoard.list({ team_id: input.teamId })

        const pending = allTasks.filter(
          (t) => t.status === "pending" && !t.assigned_engineer_id,
        )
        if (pending.length === 0) return []

        const activeEngineerIds = new Set<EngineerID>()
        for (const t of allTasks) {
          if (
            t.assigned_engineer_id &&
            (t.status === "in-progress" || t.status === "blocked")
          ) {
            activeEngineerIds.add(t.assigned_engineer_id)
          }
        }

        const available = input.engineers.filter(
          (e) =>
            e.state === "idle" && !activeEngineerIds.has(e.engineerID),
        )

        const maxNew = MAX_TEAM_SIZE - activeEngineerIds.size
        const assignable = available.slice(0, Math.max(0, maxNew))
        if (assignable.length === 0) return []

        const engineerFiles = new Map<EngineerID, Set<string>>()
        for (const t of allTasks) {
          if (
            t.assigned_engineer_id &&
            t.status !== "completed" &&
            t.status !== "failed"
          ) {
            const files = decodeFiles(t.file_scope)
            if (files.length === 0) continue
            const set = engineerFiles.get(t.assigned_engineer_id) ?? new Set()
            for (const f of files) set.add(f)
            engineerFiles.set(t.assigned_engineer_id, set)
          }
        }

        const assigned: Task[] = []
        let engIdx = 0

        for (const task of pending) {
          if (engIdx >= assignable.length) break

          const engineer = assignable[engIdx]
          const taskFiles = decodeFiles(task.file_scope)
          const owned = engineerFiles.get(engineer.engineerID) ?? new Set()
          const conflict = taskFiles.some((f) => owned.has(f))

          if (conflict) continue

          const updated = yield* taskBoard.update(task.id, {
            assigned_engineer_id: engineer.engineerID,
            status: "in-progress",
          })

          for (const f of taskFiles) owned.add(f)
          engineerFiles.set(engineer.engineerID, owned)
          assigned.push(updated)
          engIdx++

          void publishTeamEvent(Event.TaskAssigned, {
            teamID: input.teamId,
            taskId: task.id,
            engineerID: engineer.engineerID,
          })
        }

        return assigned
      },
    )

    const monitor = Effect.fn("LeadCoordinator.monitor")(
      function* (teamId: TeamID) {
        const tasks = yield* taskBoard.list({ team_id: teamId })

        const counts = {
          pending: 0,
          inProgress: 0,
          completed: 0,
          failed: 0,
          blocked: 0,
        }
        const engineerMap = new Map<EngineerID, EngineerSummary>()

        for (const t of tasks) {
          switch (t.status) {
            case "pending":
              counts.pending++
              break
            case "in-progress":
              counts.inProgress++
              break
            case "completed":
              counts.completed++
              break
            case "failed":
              counts.failed++
              break
            case "blocked":
              counts.blocked++
              break
          }

          if (t.assigned_engineer_id) {
            engineerMap.set(t.assigned_engineer_id, {
              id: t.assigned_engineer_id,
              state:
                t.status === "completed"
                  ? "idle"
                  : t.status === "failed"
                    ? "failed"
                    : t.status === "blocked"
                      ? "blocked"
                      : "working",
              currentTask: t.title,
            })
          }
        }

        const completedIds = new Set(
          tasks.filter((t) => t.status === "completed").map((t) => t.id),
        )
        const blockers = tasks.filter(
          (t) => t.status === "blocked" && t.blocked_by && !completedIds.has(t.blocked_by),
        )

        return {
          totalTasks: tasks.length,
          ...counts,
          engineers: [...engineerMap.values()],
          blockers,
        }
      },
    )

    const reassign = Effect.fn("LeadCoordinator.reassign")(
      function* (input: ReassignInput) {
        const task = yield* taskBoard.get(input.taskId)
        if (!task) {
          yield* new LeadCoordinatorError({
            message: `Task not found: ${input.taskId as string}`,
          })
        }

        const allTasks = yield* taskBoard.list({ team_id: task!.team_id })
        const taskFiles = decodeFiles(task!.file_scope)
        const targetActive = allTasks.filter(
          (t) =>
            t.assigned_engineer_id === input.toEngineer &&
            t.id !== task!.id &&
            t.status !== "completed" &&
            t.status !== "failed",
        )

        for (const active of targetActive) {
          const activeFiles = decodeFiles(active.file_scope)
          const conflict = filesOverlap(taskFiles, activeFiles)
          if (conflict.length > 0) {
            yield* new FileScopeConflictError({
              message: `Cannot reassign to engineer — file conflict with "${active.title}"`,
              conflictingFiles: conflict,
            })
          }
        }

        return yield* taskBoard.update(task!.id, {
          assigned_engineer_id: input.toEngineer,
          status: "in-progress",
        })
      },
    )

    const validateFileScopes = (
      tasks: Array<{ id: string; files: string[] }>,
    ): Effect.Effect<boolean, never> =>
      Effect.sync(() => {
        const owner = new Map<string, string>()
        for (const t of tasks) {
          for (const f of t.files) {
            if (owner.has(f)) return false
            owner.set(f, t.id)
          }
        }
        return true
      })

    const formatStatus = (report: ProgressReport): string => {
      const lines: string[] = [
        `Team Progress: ${report.completed}/${report.totalTasks} completed`,
        `  Pending: ${report.pending} | In Progress: ${report.inProgress} | Failed: ${report.failed} | Blocked: ${report.blocked}`,
      ]
      if (report.engineers.length > 0) {
        lines.push("  Engineers:")
        for (const e of report.engineers) {
          const task = e.currentTask ? ` — ${e.currentTask}` : ""
          lines.push(`    ${e.id as string} [${e.state}]${task}`)
        }
      }
      if (report.blockers.length > 0) {
        lines.push("  Blockers:")
        for (const b of report.blockers) {
          lines.push(`    ${b.title} (blocked by ${b.blocked_by as string})`)
        }
      }
      return lines.join("\n")
    }

    return Service.of({
      decompose,
      assign,
      monitor,
      reassign,
      validateFileScopes,
      formatStatus,
    })
  }),
)

export * as LeadCoordinator from "./lead-coordinator"
