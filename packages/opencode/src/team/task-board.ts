import { eq, and } from "drizzle-orm"
import { Effect, Layer, Schema, Context } from "effect"
import { Database } from "@/storage"
import {
  TaskBoardTable,
  type TaskBoardID,
  type Task,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TaskBoardFilter,
  type TaskBoardService,
  type TeamID,
} from "./task-board.sql"

const encodeDependencies = (deps: readonly TaskBoardID[]): string => JSON.stringify(deps)

const decodeDependencies = (raw: string | null | undefined): readonly TaskBoardID[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TaskBoardID[]) : []
  } catch {
    return []
  }
}

// Translate a raw DB row (dependencies as string) into a Task (dependencies as array)
const rowToTask = (row: any): Task => ({
  ...row,
  dependencies: decodeDependencies(row.dependencies),
})

type DbClient = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never
type DbTransactionCallback<A> = Parameters<typeof Database.transaction<A>>[0]

export class TaskBoardRepoError extends Schema.TaggedErrorClass<TaskBoardRepoError>()("TaskBoardRepoError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const query = <A>(f: DbTransactionCallback<A>) =>
  Effect.try({
    try: () => Database.use(f),
    catch: (cause) => new TaskBoardRepoError({ message: "Database operation failed", cause }),
  })

const tx = <A>(f: DbTransactionCallback<A>) =>
  Effect.try({
    try: () => Database.transaction(f),
    catch: (cause) => new TaskBoardRepoError({ message: "Database transaction failed", cause }),
  })

export interface Interface {
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, TaskBoardRepoError>
  readonly update: (taskId: TaskBoardID, input: UpdateTaskInput) => Effect.Effect<Task, TaskBoardRepoError>
  readonly list: (filter: TaskBoardFilter) => Effect.Effect<Task[], TaskBoardRepoError>
  readonly get: (taskId: TaskBoardID) => Effect.Effect<Task | null, TaskBoardRepoError>
  readonly delete: (taskId: TaskBoardID) => Effect.Effect<void, TaskBoardRepoError>
  /** Returns pending tasks whose every dependency is completed (or has no dependencies). */
  readonly listReadyTasks: (teamId: TeamID) => Effect.Effect<Task[], TaskBoardRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskBoardRepo") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("TaskBoardRepo.create")((input: CreateTaskInput) => {
      const id = crypto.randomUUID() as TaskBoardID
      const now = Date.now()
      const deps = input.dependencies ?? []
      return query((db) => {
        db.insert(TaskBoardTable)
          .values({
            id,
            team_id: input.team_id,
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? "pending",
            assigned_engineer_id: input.assigned_engineer_id ?? null,
            file_scope: input.file_scope ?? null,
            blocked_by: input.blocked_by ?? null,
            parent_task_id: input.parent_task_id ?? null,
            dependencies: encodeDependencies(deps),
            time_created: now,
            time_updated: now,
            completed_at: null,
          })
          .run()
        return {
          id,
          team_id: input.team_id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "pending",
          assigned_engineer_id: input.assigned_engineer_id ?? null,
          file_scope: input.file_scope ?? null,
          blocked_by: input.blocked_by ?? null,
          parent_task_id: input.parent_task_id ?? null,
          dependencies: deps,
          time_created: now,
          time_updated: now,
          completed_at: null,
        } as Task
      })
    })

    const update = Effect.fn("TaskBoardRepo.update")((taskId: TaskBoardID, input: UpdateTaskInput) => {
      return tx((db) => {
        const existing = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, taskId)).get()
        if (!existing) throw new TaskBoardRepoError({ message: `Task not found: ${taskId}` })

        const newDeps = input.dependencies !== undefined
          ? encodeDependencies(input.dependencies)
          : existing.dependencies

        const updated = {
          title: input.title ?? existing.title,
          description: input.description !== undefined ? input.description : existing.description,
          status: input.status ?? existing.status,
          assigned_engineer_id:
            input.assigned_engineer_id !== undefined ? input.assigned_engineer_id : existing.assigned_engineer_id,
          file_scope: input.file_scope !== undefined ? input.file_scope : existing.file_scope,
          blocked_by: input.blocked_by !== undefined ? input.blocked_by : existing.blocked_by,
          parent_task_id: input.parent_task_id !== undefined ? input.parent_task_id : existing.parent_task_id,
          completed_at: input.completed_at !== undefined ? input.completed_at : existing.completed_at,
          dependencies: newDeps,
          time_updated: Date.now(),
        }

        db.update(TaskBoardTable).set(updated).where(eq(TaskBoardTable.id, taskId)).run()
        return rowToTask({ ...existing, ...updated })
      })
    })

    const list = Effect.fn("TaskBoardRepo.list")((filter: TaskBoardFilter) => {
      return query((db) => {
        const conditions = [eq(TaskBoardTable.team_id, filter.team_id)]
        if (filter.status) conditions.push(eq(TaskBoardTable.status, filter.status))
        if (filter.assigned_engineer_id)
          conditions.push(eq(TaskBoardTable.assigned_engineer_id, filter.assigned_engineer_id))

        return db.select().from(TaskBoardTable).where(and(...conditions)).all().map(rowToTask)
      })
    })

    const get = Effect.fn("TaskBoardRepo.get")((taskId: TaskBoardID) => {
      return query((db) => {
        const result = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, taskId)).get()
        return result ? rowToTask(result) : null
      })
    })

    const listReadyTasks = Effect.fn("TaskBoardRepo.listReadyTasks")((teamId: TeamID) => {
      return query((db) => {
        const allTasks = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.team_id, teamId)).all().map(rowToTask)
        const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id))
        return allTasks.filter(
          (t) =>
            t.status === "pending" &&
            !t.assigned_engineer_id &&
            t.dependencies.every((depId) => completedIds.has(depId)),
        )
      })
    })

    const remove = Effect.fn("TaskBoardRepo.delete")((taskId: TaskBoardID) => {
      return tx((db) => {
        db.delete(TaskBoardTable).where(eq(TaskBoardTable.id, taskId)).run()
      }).pipe(Effect.asVoid)
    })

    return Service.of({
      create,
      update,
      list,
      get,
      delete: remove,
      listReadyTasks,
    })
  }),
)

export * as TaskBoardRepo from "./task-board"
