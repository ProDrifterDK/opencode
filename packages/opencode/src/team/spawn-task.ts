import type { Task } from "./task-board.sql"

type SpawnTaskInput = {
  title: string
  description: string
  fileScope: string | null
}

export function resolveSpawnTaskCandidate(input: {
  tasks: readonly Pick<Task, "id" | "title" | "description" | "file_scope" | "status" | "assigned_engineer_id">[]
  task: SpawnTaskInput
}) {
  const matches = input.tasks.filter((task) =>
    task.status === "pending" &&
    task.assigned_engineer_id === null &&
    task.title === input.task.title &&
    task.description === input.task.description &&
    task.file_scope === input.task.fileScope
  )
  if (matches.length === 0) return { kind: "create" as const }
  if (matches.length === 1) return { kind: "claim" as const, task: matches[0] }
  return { kind: "ambiguous" as const, count: matches.length }
}

export * as TeamSpawnTask from "./spawn-task"
