import { Effect, Layer, Context, Schema } from "effect"
import { Log } from "@/util"
import { globOverlap } from "./git-manager"
import { TaskBoardRepo, TaskBoardRepoError } from "./task-board"
import { type EngineerID, type EngineerStateRecord } from "./types"
import { MAX_TEAM_SIZE, TASK_BOARD_MAX_TASKS } from "./constants"
import { Event, publishTeamEvent } from "./events"
import { RateLimiter } from "./rate-limiter"
import type { RateLimiterStats } from "./rate-limiter"
import type {
  Task,
  TaskBoardID,
  TeamID,
} from "./task-board.sql"

const log = Log.create({ service: "team.lead-coordinator" })

export class LeadCoordinatorError extends Schema.TaggedErrorClass<LeadCoordinatorError>()(
  "LeadCoordinatorError",
  { message: Schema.String },
) {}

export class FileScopeConflictError extends Schema.TaggedErrorClass<FileScopeConflictError>()(
  "FileScopeConflictError",
  { message: Schema.String, conflictingFiles: Schema.Array(Schema.String) },
) {}

export class CyclicDependenciesError extends Schema.TaggedErrorClass<CyclicDependenciesError>()(
  "CyclicDependenciesError",
  { message: Schema.String, cycle: Schema.Array(Schema.String) },
) {}

export interface SubtaskSpec {
  id?: string
  title: string
  description: string
  files?: string[]
  fileScope?: string[]
  dependencies?: string[]
  complexity?: "low" | "medium" | "high"
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

export interface RetaskInput {
  taskId: TaskBoardID
  title?: string
  description?: string
  fileScope?: string[]
}

export interface FileScopeWarning {
  task: string
  conflictsWith: string
  taskFiles: string[]
  conflictingFiles: string[]
  message: string
}

export interface DecomposeResult {
  tasks: Task[]
  warnings: FileScopeWarning[]
}

export interface TaskWithWarningsResult {
  task: Task
  warnings: FileScopeWarning[]
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
  rateLimits?: RateLimiterStats | null
}

const encodeFiles = (files: string[]): string => JSON.stringify(files)

const subtaskFiles = (spec: SubtaskSpec) => spec.fileScope ?? spec.files ?? []

const decodeFiles = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === "string") : []
  } catch {
    return []
  }
}

const makeFileScopeWarning = (input: {
  task: string
  conflictsWith: string
  taskFiles: string[]
  conflictingFiles: string[]
}): FileScopeWarning => ({
  ...input,
  message: `Coordinate before editing overlapping file scopes: "${input.task}" overlaps with "${input.conflictsWith}".`,
})

const hasFileScopeOverlap = (aFiles: string[], bFiles: string[]) =>
  aFiles.length > 0 &&
  bFiles.length > 0 &&
  aFiles.some((af) => bFiles.some((bf) => globOverlap(af, bf)))

export const findFileScopeWarnings = (input: {
  task: { id?: string; title: string; files: string[] }
  others: Array<{ id?: string; title: string; files: string[] }>
}): FileScopeWarning[] =>
  input.others
    .filter((other) => hasFileScopeOverlap(input.task.files, other.files))
    .map((other) =>
      makeFileScopeWarning({
        task: input.task.id ?? input.task.title,
        conflictsWith: other.id ?? other.title,
        taskFiles: input.task.files,
        conflictingFiles: other.files,
      })
    )

const findPairwiseFileScopeWarnings = (tasks: Array<{ id?: string; title: string; files: string[] }>) =>
  tasks.flatMap((task, index) =>
    findFileScopeWarnings({
      task,
      others: tasks.slice(index + 1),
    })
  )

type Err = LeadCoordinatorError | FileScopeConflictError | CyclicDependenciesError | TaskBoardRepoError

export interface Interface {
  readonly decompose: (
    input: DecomposeInput,
  ) => Effect.Effect<DecomposeResult, Err>
  readonly assign: (
    input: AssignInput,
  ) => Effect.Effect<Task[], Err>
  readonly monitor: (
    teamId: TeamID,
  ) => Effect.Effect<ProgressReport, Err>
  readonly reassign: (
    input: ReassignInput,
  ) => Effect.Effect<TaskWithWarningsResult, Err>
  readonly retask: (
    input: RetaskInput,
  ) => Effect.Effect<TaskWithWarningsResult, Err>
  readonly validateFileScopes: (
    tasks: Array<{ id: string; files: string[] }>,
  ) => Effect.Effect<boolean, never>
  readonly formatStatus: (report: ProgressReport) => string
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/LeadCoordinator",
) {}

export const layer: Layer.Layer<Service, never, TaskBoardRepo.Service | RateLimiter.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const taskBoard = yield* TaskBoardRepo.Service
    const rateLimiter = yield* RateLimiter.Service

    const decompose = Effect.fn("LeadCoordinator.decompose")(
      function* (input: DecomposeInput) {
        const specs = input.subtasks

        // ── Validate client-side IDs are unique ────────────────────────────
        const clientIdSet = new Set<string>()
        for (const spec of specs) {
          if (spec.id !== undefined) {
            if (clientIdSet.has(spec.id)) {
              yield* new LeadCoordinatorError({
                message: `Duplicate subtask id: "${spec.id}"`,
              })
            }
            clientIdSet.add(spec.id)
          }
        }

        // ── Validate dependency references exist ───────────────────────────
        for (const spec of specs) {
          for (const dep of spec.dependencies ?? []) {
            if (!clientIdSet.has(dep)) {
              yield* new LeadCoordinatorError({
                message: `Subtask "${spec.title}" depends on unknown id "${dep}"`,
              })
            }
          }
        }

        // ── Cycle detection via Kahn's algorithm ───────────────────────────
        // Build adjacency and in-degree maps on client-side IDs
        const adj = new Map<string, string[]>()
        const inDegree = new Map<string, number>()
        for (const spec of specs) {
          const nodeId = spec.id ?? spec.title
          adj.set(nodeId, [])
          inDegree.set(nodeId, 0)
        }
        for (const spec of specs) {
          const nodeId = spec.id ?? spec.title
          for (const dep of spec.dependencies ?? []) {
            // dep must complete before nodeId — edge: dep → nodeId
            adj.get(dep)!.push(nodeId)
            inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1)
          }
        }
        const queue: string[] = []
        for (const [id, deg] of inDegree) {
          if (deg === 0) queue.push(id)
        }
        let processed = 0
        while (queue.length > 0) {
          const node = queue.shift()!
          processed++
          for (const neighbor of adj.get(node) ?? []) {
            const newDeg = (inDegree.get(neighbor) ?? 0) - 1
            inDegree.set(neighbor, newDeg)
            if (newDeg === 0) queue.push(neighbor)
          }
        }
        if (processed < specs.length) {
          // Cycle exists — collect nodes still in cycle
          const cycleNodes = [...inDegree.entries()]
            .filter(([, deg]) => deg > 0)
            .map(([id]) => id)
          yield* new CyclicDependenciesError({
            message: `Cyclic dependencies detected among subtasks: ${cycleNodes.join(" → ")}`,
            cycle: cycleNodes,
          })
        }

        const warnings = findPairwiseFileScopeWarnings(specs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          files: subtaskFiles(spec),
        })))

        const existing = yield* taskBoard.list({ team_id: input.teamId })
        if (existing.length + specs.length > TASK_BOARD_MAX_TASKS) {
          yield* new LeadCoordinatorError({
            message: `Task board full (${existing.length}/${TASK_BOARD_MAX_TASKS})`,
          })
        }

        // ── Create tasks, then build client-id → TaskBoardID map ──────────
        // Two-pass: first create all tasks, then we have the real IDs
        const clientIdToTaskId = new Map<string, TaskBoardID>()
        const created: Task[] = []

        // First pass: create tasks without dependencies (resolve after)
        for (const spec of specs) {
          const files = subtaskFiles(spec)
          const task = yield* taskBoard.create({
            team_id: input.teamId,
            title: spec.title,
            description: spec.description,
            file_scope: files.length > 0 ? encodeFiles(files) : null,
            status: "pending",
            dependencies: [],
          })
          if (spec.complexity !== undefined) {
            yield* Effect.sync(() =>
              log.info(`Lead annotated task "${spec.title}" as complexity=${spec.complexity}`),
            )
          }
          const clientId = spec.id ?? spec.title
          clientIdToTaskId.set(clientId, task.id)
          created.push(task)
        }

        // Second pass: update dependencies using real TaskBoardIDs
        const updated: Task[] = []
        for (let i = 0; i < specs.length; i++) {
          const spec = specs[i]
          const clientId = spec.id ?? spec.title
          const deps = (spec.dependencies ?? []).map((depClientId) => clientIdToTaskId.get(depClientId)!)
          if (deps.length > 0) {
            const updatedTask = yield* taskBoard.update(created[i].id, { dependencies: deps })
            updated.push(updatedTask)
          } else {
            updated.push(created[i])
          }
        }

        return { tasks: updated, warnings }
      },
    )

    const assign = Effect.fn("LeadCoordinator.assign")(
      function* (input: AssignInput) {
        const allTasks = yield* taskBoard.list({ team_id: input.teamId })

        // Only assign tasks whose dependencies are all completed (ready tasks)
        const pending = yield* taskBoard.listReadyTasks(input.teamId)
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

          const updated = yield* taskBoard.claim(task.id, engineer.engineerID)
          if (!updated) continue

          for (const f of taskFiles) owned.add(f)
          engineerFiles.set(engineer.engineerID, owned)
          assigned.push(updated)
          engIdx++

          void publishTeamEvent(Event.TaskAssigned, {
            teamID: input.teamId,
            taskId: updated.id,
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

        const rateLimits = rateLimiter.getStats(teamId)

        return {
          totalTasks: tasks.length,
          ...counts,
          engineers: [...engineerMap.values()],
          blockers,
          rateLimits,
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

        const warnings = findFileScopeWarnings({
          task: { id: task!.id, title: task!.title, files: taskFiles },
          others: targetActive.map((active) => ({
            id: active.id,
            title: active.title,
            files: decodeFiles(active.file_scope),
          })),
        })

        const updated = yield* taskBoard.update(task!.id, {
          assigned_engineer_id: input.toEngineer,
          status: "in-progress",
        })
        return { task: updated, warnings }
      },
    )

    const retask = Effect.fn("LeadCoordinator.retask")(
      function* (input: RetaskInput) {
        const task = yield* taskBoard.get(input.taskId)
        if (!task) {
          return yield* new LeadCoordinatorError({
            message: `Task not found: ${input.taskId as string}`,
          })
        }

        if (
          task.status === "in-progress" ||
          task.status === "completed" ||
          task.status === "failed"
        ) {
          return yield* new LeadCoordinatorError({
            message: `Cannot retask a ${task.status} task`,
          })
        }

        if (
          input.title === undefined &&
          input.description === undefined &&
          input.fileScope === undefined
        ) {
          return yield* new LeadCoordinatorError({
            message: "retask requires at least one of title/description/fileScope",
          })
        }

        const warnings = input.fileScope === undefined
          ? []
          : yield* Effect.gen(function* () {
              const allTasks = yield* taskBoard.list({ team_id: task.team_id })
              const otherActive = allTasks.filter(
                (t) =>
                  t.id !== task.id &&
                  (t.status === "pending" || t.status === "in-progress" || t.status === "blocked"),
              )
              return findFileScopeWarnings({
                task: { id: task.id, title: input.title ?? task.title, files: input.fileScope ?? [] },
                others: otherActive.map((active) => ({
                  id: active.id,
                  title: active.title,
                  files: decodeFiles(active.file_scope),
                })),
              })
            })

        const updateInput: import("./task-board.sql").UpdateTaskInput = {}
        if (input.title !== undefined) updateInput.title = input.title
        if (input.description !== undefined) updateInput.description = input.description
        if (input.fileScope !== undefined) updateInput.file_scope = encodeFiles(input.fileScope)

        const updated = yield* taskBoard.update(task.id, updateInput)
        return { task: updated, warnings }
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
      if (report.rateLimits != null) {
        const rl = report.rateLimits
        const tokenPct = rl.tokensBudgetPerMinute > 0
          ? Math.round((rl.tokensUsedThisMinute / rl.tokensBudgetPerMinute) * 100)
          : 0
        const cbState = rl.circuitBreakerOpen ? "open" : "closed"
        lines.push(
          `  Rate limits: tokens ${rl.tokensUsedThisMinute}/${rl.tokensBudgetPerMinute} (${tokenPct}%), active ${rl.activeCalls}, queued ${rl.queuedCalls}, CB: ${cbState}${rl.consecutive429s > 0 ? ` (${rl.consecutive429s} 429s)` : ""}`,
        )
      }
      return lines.join("\n")
    }

    return Service.of({
      decompose,
      assign,
      monitor,
      reassign,
      retask,
      validateFileScopes,
      formatStatus,
    })
  }),
)

export * as LeadCoordinator from "./lead-coordinator"
