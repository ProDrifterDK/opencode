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
} from "./task-board.sql"

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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskBoardRepo") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("TaskBoardRepo.create")((input: CreateTaskInput) => {
      const id = crypto.randomUUID() as TaskBoardID
      const now = Date.now()
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
          time_updated: Date.now(),
        }

        db.update(TaskBoardTable).set(updated).where(eq(TaskBoardTable.id, taskId)).run()
        return { ...existing, ...updated } as Task
      })
    })

    const list = Effect.fn("TaskBoardRepo.list")((filter: TaskBoardFilter) => {
      return query((db) => {
        const conditions = [eq(TaskBoardTable.team_id, filter.team_id)]
        if (filter.status) conditions.push(eq(TaskBoardTable.status, filter.status))
        if (filter.assigned_engineer_id)
          conditions.push(eq(TaskBoardTable.assigned_engineer_id, filter.assigned_engineer_id))

        return db.select().from(TaskBoardTable).where(and(...conditions)).all() as Task[]
      })
    })

    const get = Effect.fn("TaskBoardRepo.get")((taskId: TaskBoardID) => {
      return query((db) => {
        const result = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, taskId)).get()
        return (result ?? null) as Task | null
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
    })
  }),
)

export * as TaskBoardRepo from "./task-board"
