import type { Task } from "./task-board.sql"

type SpawnTaskInput = {
  title: string
  description: string
  fileScope: string | null
}

const canonicalFileScope = (raw: string | null) => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return raw
    const files = [...new Set(parsed.filter((file): file is string => typeof file === "string"))].sort()
    return files.length > 0 ? JSON.stringify(files) : null
  } catch {
    return raw
  }
}

export function resolveSpawnTaskCandidate(input: {
  tasks: readonly Pick<Task, "id" | "title" | "description" | "file_scope" | "status" | "assigned_engineer_id">[]
  task: SpawnTaskInput
}) {
  const inputFileScope = canonicalFileScope(input.task.fileScope)
  const matches = input.tasks.filter((task) =>
    task.status === "pending" &&
    task.assigned_engineer_id === null &&
    task.title === input.task.title &&
    task.description === input.task.description &&
    canonicalFileScope(task.file_scope) === inputFileScope
  )
  if (matches.length === 0) return { kind: "create" as const }
  if (matches.length === 1) return { kind: "claim" as const, task: matches[0] }
  return { kind: "ambiguous" as const, count: matches.length }
}

export * as TeamSpawnTask from "./spawn-task"
