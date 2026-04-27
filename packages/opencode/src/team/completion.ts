import type { EngineerStateRecord } from "./types"
import type { Task } from "./task-board.sql"

export function isTeamWorkComplete(input: {
  tasks: readonly Pick<Task, "status">[]
  engineers: readonly Pick<EngineerStateRecord, "state">[]
}) {
  if (input.tasks.length === 0) return false
  if (input.engineers.length === 0) return false
  return input.tasks.every((task) => task.status === "completed") &&
    input.engineers.every((engineer) => engineer.state === "idle")
}

export function buildTeamCompleteMessage(input: {
  teamID: string
  completedTasks: number
}) {
  return [
    `✅ Team ${input.teamID} complete`,
    `All ${input.completedTasks} task${input.completedTasks === 1 ? "" : "s"} completed.`,
    `All engineers are idle. Use team_tasks(showAll: true) to get completed task IDs, review reports and changed files, then run team_commit with reviewedTaskIDs for the tasks you approved or team_dissolve when ready.`,
  ].join("\n")
}

export function buildEngineerReportMessage(input: {
  engineerName: string
  taskTitle: string
  summary: string
}) {
  return [
    `✅ Engineer ${input.engineerName} reports: COMPLETED`,
    `Task: ${input.taskTitle}`,
    `Summary: ${input.summary}`,
  ].join("\n")
}

export * as TeamCompletion from "./completion"
