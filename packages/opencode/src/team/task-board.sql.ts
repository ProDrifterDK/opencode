import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import { Schema } from "effect"

export const TaskBoardID = Schema.String.pipe(Schema.brand("TaskBoardID"))
export type TaskBoardID = Schema.Schema.Type<typeof TaskBoardID>

export const TeamID = Schema.String.pipe(Schema.brand("TeamID"))
export type TeamID = Schema.Schema.Type<typeof TeamID>

export const EngineerID = Schema.String.pipe(Schema.brand("EngineerID"))
export type EngineerID = Schema.Schema.Type<typeof EngineerID>

export type TaskStatus = "pending" | "in-progress" | "blocked" | "completed" | "failed"

export interface Task {
  id: TaskBoardID
  team_id: TeamID
  title: string
  description: string | null
  status: TaskStatus
  assigned_engineer_id: EngineerID | null
  file_scope: string | null
  blocked_by: TaskBoardID | null
  parent_task_id: TaskBoardID | null
  dependencies: readonly TaskBoardID[]
  time_created: number
  time_updated: number
  completed_at: number | null
  archived_at: number | null
}

export interface CreateTaskInput {
  team_id: TeamID
  title: string
  description?: string | null
  status?: TaskStatus
  assigned_engineer_id?: EngineerID | null
  file_scope?: string | null
  blocked_by?: TaskBoardID | null
  parent_task_id?: TaskBoardID | null
  dependencies?: readonly TaskBoardID[]
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  status?: TaskStatus
  assigned_engineer_id?: EngineerID | null
  file_scope?: string | null
  blocked_by?: TaskBoardID | null
  parent_task_id?: TaskBoardID | null
  completed_at?: number | null
  dependencies?: readonly TaskBoardID[]
}

export interface TaskBoardFilter {
  team_id: TeamID
  status?: TaskStatus
  assigned_engineer_id?: EngineerID
}

export interface TaskBoardService {
  create(input: CreateTaskInput): Task
  update(taskId: TaskBoardID, input: UpdateTaskInput): Task
  list(filter: TaskBoardFilter): Task[]
  get(taskId: TaskBoardID): Task | null
  delete(taskId: TaskBoardID): void
}

export const TaskBoardTable = sqliteTable(
  "task_board",
  {
    id: text().$type<TaskBoardID>().primaryKey(),
    team_id: text().$type<TeamID>().notNull(),
    title: text().notNull(),
    description: text(),
    status: text().$type<TaskStatus>().notNull(),
    assigned_engineer_id: text().$type<EngineerID>(),
    file_scope: text(),
    blocked_by: text().$type<TaskBoardID>(),
    parent_task_id: text().$type<TaskBoardID>(),
    dependencies: text().notNull().default("[]"),
    ...Timestamps,
    completed_at: integer(),
    archived_at: integer(),
  },
  (table) => [
    index("task_board_team_id_idx").on(table.team_id),
    index("task_board_assigned_engineer_id_idx").on(table.assigned_engineer_id),
    index("task_board_status_idx").on(table.status),
  ],
)
