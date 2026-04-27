import type { Task } from "./task-board.sql"

export function hasCompletedAssignedTask(tasks: readonly Task[]) {
  return tasks.some((task) => task.status === "completed")
}

export * as TeamClaimPolicy from "./claim-policy"
