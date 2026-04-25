import { Effect, Layer, Context, Schema } from "effect"
import { TaskBoardRepo, TaskBoardRepoError } from "./task-board"
import { type EngineerID } from "./types"
import { TASK_BOARD_MAX_TASKS } from "./constants"
import { Event, publishTeamEvent } from "./events"
import type {
  Task,
  TaskBoardID,
  TeamID,
  TaskStatus,
  CreateTaskInput,
  UpdateTaskInput,
  TaskBoardFilter,
} from "./task-board.sql"

// ─── Errors ────────────────────────────────────────────────────────────────────

export class TaskBoardServiceError extends Schema.TaggedErrorClass<TaskBoardServiceError>()(
  "TaskBoardServiceError",
  { message: Schema.String },
) {}

export class OwnershipDeniedError extends Schema.TaggedErrorClass<OwnershipDeniedError>()(
  "OwnershipDeniedError",
  {
    taskId: Schema.String,
    engineerId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Ownership denied for task ${this.taskId}: engineer ${this.engineerId} — ${this.reason}`
  }
}

export class InvalidStatusTransitionError extends Schema.TaggedErrorClass<InvalidStatusTransitionError>()(
  "InvalidStatusTransitionError",
  {
    taskId: Schema.String,
    from: Schema.String,
    to: Schema.String,
  },
) {
  override get message() {
    return `Invalid status transition on task ${this.taskId}: ${this.from} → ${this.to}`
  }
}

export class TaskBoardFullError extends Schema.TaggedErrorClass<TaskBoardFullError>()(
  "TaskBoardFullError",
  {
    teamId: Schema.String,
    current: Schema.Number,
    max: Schema.Number,
  },
) {
  override get message() {
    return `Task board full for team ${this.teamId}: ${this.current}/${this.max}`
  }
}

export class TaskDependenciesNotMetError extends Schema.TaggedErrorClass<TaskDependenciesNotMetError>()(
  "TaskDependenciesNotMetError",
  {
    taskId: Schema.String,
    unmetDependencies: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Task ${this.taskId} has unmet dependencies: ${this.unmetDependencies.join(", ")}`
  }
}

// ─── Status transition map ─────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending: new Set(["in-progress"]),
  "in-progress": new Set(["completed", "failed", "blocked"]),
  blocked: new Set(["in-progress", "failed"]),
  completed: new Set(),
  failed: new Set(),
}

const isValidTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  ALLOWED_TRANSITIONS[from].has(to)

// ─── Service interface ─────────────────────────────────────────────────────────

type Err =
  | TaskBoardServiceError
  | OwnershipDeniedError
  | InvalidStatusTransitionError
  | TaskBoardFullError
  | TaskDependenciesNotMetError
  | TaskBoardRepoError

export interface Interface {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, Err>
  readonly updateTaskStatus: (
    taskId: TaskBoardID,
    callerId: EngineerID,
    isLead: boolean,
    status: TaskStatus,
  ) => Effect.Effect<Task, Err>
  readonly assignTask: (
    taskId: TaskBoardID,
    callerId: EngineerID,
    isLead: boolean,
    engineerId: EngineerID,
  ) => Effect.Effect<Task, Err>
  readonly listTasks: (filter: TaskBoardFilter) => Effect.Effect<Task[], Err>
  readonly getTask: (taskId: TaskBoardID) => Effect.Effect<Task | null, Err>
  readonly deleteTask: (
    taskId: TaskBoardID,
    callerId: EngineerID,
    isLead: boolean,
  ) => Effect.Effect<void, Err>
  readonly updateTask: (
    taskId: TaskBoardID,
    callerId: EngineerID,
    isLead: boolean,
    input: UpdateTaskInput,
  ) => Effect.Effect<Task, Err>
  readonly createMultiple: (
    inputs: CreateTaskInput[],
  ) => Effect.Effect<Task[], Err>
  readonly updateMultiple: (
    updates: Array<{ taskId: TaskBoardID; input: UpdateTaskInput }>,
    callerId: EngineerID,
    isLead: boolean,
  ) => Effect.Effect<Task[], Err>
  readonly listByStatus: (
    teamId: TeamID,
    status: TaskStatus,
  ) => Effect.Effect<Task[], Err>
  readonly listByEngineer: (
    teamId: TeamID,
    engineerId: EngineerID,
  ) => Effect.Effect<Task[], Err>
  readonly listBlocked: (teamId: TeamID) => Effect.Effect<Task[], Err>
  readonly listReadyTasks: (teamId: TeamID) => Effect.Effect<Task[], Err>
  readonly checkDependencies: (taskId: TaskBoardID) => Effect.Effect<void, Err>
}

// ─── Ownership check ───────────────────────────────────────────────────────────

const checkOwnership = (
  task: Task,
  callerId: EngineerID,
  isLead: boolean,
): Effect.Effect<void, OwnershipDeniedError> =>
  Effect.gen(function* () {
    if (isLead) return
    if (task.assigned_engineer_id === callerId) return
    yield* new OwnershipDeniedError({
      taskId: task.id,
      engineerId: callerId,
      reason: "engineer can only update own tasks",
    })
  })

// ─── Service ───────────────────────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskBoardService") {}

export const layer: Layer.Layer<Service, never, TaskBoardRepo.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* TaskBoardRepo.Service

    const createTask = Effect.fn("TaskBoardService.createTask")(
      function* (input: CreateTaskInput) {
        const existing = yield* repo.list({ team_id: input.team_id })
        if (existing.length >= TASK_BOARD_MAX_TASKS) {
          yield* new TaskBoardFullError({
            teamId: input.team_id,
            current: existing.length,
            max: TASK_BOARD_MAX_TASKS,
          })
        }
        return yield* repo.create(input)
      },
    )

    const updateTask = Effect.fn("TaskBoardService.updateTask")(
      function* (
        taskId: TaskBoardID,
        callerId: EngineerID,
        isLead: boolean,
        input: UpdateTaskInput,
      ) {
        const task = yield* repo.get(taskId)
        if (!task) {
          yield* new TaskBoardServiceError({ message: `Task not found: ${taskId}` })
        }
        yield* checkOwnership(task!, callerId, isLead)
        if (input.status && input.status !== task!.status) {
          if (!isValidTransition(task!.status, input.status)) {
            yield* new InvalidStatusTransitionError({
              taskId,
              from: task!.status,
              to: input.status,
            })
          }
          // Reject claim/start if dependencies are not all completed
          if (input.status === "in-progress" && task!.status === "pending") {
            yield* checkDependencies(taskId)
          }
        }
        const oldStatus = task!.status
        const updated = yield* repo.update(taskId, input)

        if (input.status && input.status !== oldStatus) {
          void publishTeamEvent(Event.TaskUpdated, {
            teamID: updated.team_id,
            taskId,
            status: updated.status,
            oldStatus,
          })

          if (updated.status === "completed" && updated.assigned_engineer_id) {
            void publishTeamEvent(Event.TaskCompleted, {
              teamID: updated.team_id,
              taskId,
              engineerID: updated.assigned_engineer_id,
            })
          }

          if (updated.status === "completed") {
            yield* repo.update(taskId, { completed_at: Date.now() })
          }
        }

        return updated
      },
    )

    const updateTaskStatus = Effect.fn("TaskBoardService.updateTaskStatus")(
      function* (
        taskId: TaskBoardID,
        callerId: EngineerID,
        isLead: boolean,
        status: TaskStatus,
      ) {
        return yield* updateTask(taskId, callerId, isLead, { status })
      },
    )

    const assignTask = Effect.fn("TaskBoardService.assignTask")(
      function* (
        taskId: TaskBoardID,
        callerId: EngineerID,
        isLead: boolean,
        engineerId: EngineerID,
      ) {
        if (!isLead) {
          yield* new OwnershipDeniedError({
            taskId,
            engineerId: callerId,
            reason: "only lead can assign tasks",
          })
        }
        return yield* repo.update(taskId, {
          assigned_engineer_id: engineerId,
          status: "in-progress",
        })
      },
    )

    const listTasks = Effect.fn("TaskBoardService.listTasks")(
      function* (filter: TaskBoardFilter) {
        return yield* repo.list(filter)
      },
    )

    const getTask = Effect.fn("TaskBoardService.getTask")(
      function* (taskId: TaskBoardID) {
        return yield* repo.get(taskId)
      },
    )

    const deleteTask = Effect.fn("TaskBoardService.deleteTask")(
      function* (
        taskId: TaskBoardID,
        callerId: EngineerID,
        isLead: boolean,
      ) {
        if (!isLead) {
          const task = yield* repo.get(taskId)
          if (!task) {
            yield* new TaskBoardServiceError({ message: `Task not found: ${taskId}` })
          }
          yield* checkOwnership(task!, callerId, isLead)
        }
        yield* repo.delete(taskId)
      },
    )

    const createMultiple = Effect.fn("TaskBoardService.createMultiple")(
      function* (inputs: CreateTaskInput[]) {
        if (inputs.length === 0) return []
        const teamId = inputs[0].team_id
        const existing = yield* repo.list({ team_id: teamId })
        if (existing.length + inputs.length > TASK_BOARD_MAX_TASKS) {
          yield* new TaskBoardFullError({
            teamId,
            current: existing.length,
            max: TASK_BOARD_MAX_TASKS,
          })
        }
        const created: Task[] = []
        for (const input of inputs) {
          created.push(yield* repo.create(input))
        }
        return created
      },
    )

    const updateMultiple = Effect.fn("TaskBoardService.updateMultiple")(
      function* (
        updates: Array<{ taskId: TaskBoardID; input: UpdateTaskInput }>,
        callerId: EngineerID,
        isLead: boolean,
      ) {
        const results: Task[] = []
        for (const { taskId, input } of updates) {
          results.push(yield* updateTask(taskId, callerId, isLead, input))
        }
        return results
      },
    )

    const listByStatus = Effect.fn("TaskBoardService.listByStatus")(
      function* (teamId: TeamID, status: TaskStatus) {
        return yield* repo.list({ team_id: teamId, status })
      },
    )

    const listByEngineer = Effect.fn("TaskBoardService.listByEngineer")(
      function* (teamId: TeamID, engineerId: EngineerID) {
        return yield* repo.list({ team_id: teamId, assigned_engineer_id: engineerId })
      },
    )

    const listBlocked = Effect.fn("TaskBoardService.listBlocked")(
      function* (teamId: TeamID) {
        return yield* repo.list({ team_id: teamId, status: "blocked" })
      },
    )

    const listReadyTasks = Effect.fn("TaskBoardService.listReadyTasks")(
      function* (teamId: TeamID) {
        return yield* repo.listReadyTasks(teamId)
      },
    )

    const checkDependencies = Effect.fn("TaskBoardService.checkDependencies")(
      function* (taskId: TaskBoardID) {
        const task = yield* repo.get(taskId)
        if (!task) return
        if (task.dependencies.length === 0) return
        const allTasks = yield* repo.list({ team_id: task.team_id })
        const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id))
        const unmet = task.dependencies.filter((depId) => !completedIds.has(depId))
        if (unmet.length > 0) {
          yield* new TaskDependenciesNotMetError({ taskId, unmetDependencies: unmet as string[] })
        }
      },
    )

    return Service.of({
      createTask,
      updateTaskStatus,
      assignTask,
      listTasks,
      getTask,
      deleteTask,
      updateTask,
      createMultiple,
      updateMultiple,
      listByStatus,
      listByEngineer,
      listBlocked,
      listReadyTasks,
      checkDependencies,
    })
  }),
)

export * as TaskBoardService from "./task-board-service"
