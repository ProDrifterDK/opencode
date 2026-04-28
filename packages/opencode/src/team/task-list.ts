import type { Task } from "./task-board.sql"
import { findFileScopeWarnings, type FileScopeWarning } from "./lead-coordinator"
import { decodeReviewPacket, type ReviewPacket } from "./review-packet"

export const decodeTaskFileScope = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

export const computeTaskWarnings = (input: {
  task: Pick<Task, "id" | "title" | "file_scope">
  tasks: readonly Pick<Task, "id" | "title" | "file_scope" | "status">[]
}): FileScopeWarning[] =>
  findFileScopeWarnings({
    task: {
      id: input.task.id,
      title: input.task.title,
      files: decodeTaskFileScope(input.task.file_scope),
    },
    others: input.tasks
      .filter((task) =>
        task.id !== input.task.id &&
        task.status !== "completed" &&
        task.status !== "failed"
      )
      .map((task) => ({
        id: task.id,
        title: task.title,
        files: decodeTaskFileScope(task.file_scope),
      })),
  })

export type RenderedTaskMetadata = {
  taskID: Task["id"]
  title: string
  status: Task["status"]
  assignedTo: Task["assigned_engineer_id"]
  fileScope: string[]
  coordinationWarnings: FileScopeWarning[]
  reviewPacket: ReviewPacket | null
}

export function renderTaskList(input: {
  tasks: readonly Task[]
  allTasks: readonly Task[]
  showAll?: boolean
}) {
  const lines: string[] = [
    input.showAll ? "All tasks:" : "Available tasks (pending, unassigned):",
    "",
  ]

  const metadataTasks: RenderedTaskMetadata[] = []

  for (const task of input.tasks) {
    const statusEmoji =
      task.status === "pending" ? "⏳" :
      task.status === "in-progress" ? "🔨" :
      task.status === "completed" ? "✅" :
      task.status === "blocked" ? "🚧" : "❌"
    const assignee = task.assigned_engineer_id ? ` [${task.assigned_engineer_id}]` : " [unclaimed]"
    lines.push(`${statusEmoji} ${task.id}: ${task.title}${assignee}`)
    if (task.description) {
      lines.push(`   ${task.description.slice(0, 60)}${task.description.length > 60 ? "..." : ""}`)
    }

    const fileScope = decodeTaskFileScope(task.file_scope)
    if (fileScope.length > 0) lines.push(`   File scope: ${fileScope.join(", ")}`)

    const coordinationWarnings = computeTaskWarnings({ task, tasks: input.allTasks })
    if (coordinationWarnings.length > 0) {
      lines.push(`   Coordination warnings: ${coordinationWarnings.map((warning) => warning.message).join("; ")}`)
    }

    const reviewPacket = decodeReviewPacket(task.review_packet)
    if (reviewPacket) {
      if (reviewPacket.reportPath) lines.push(`   Report: ${reviewPacket.reportPath}`)
      if (reviewPacket.changedFiles.length > 0) lines.push(`   Changed files: ${reviewPacket.changedFiles.join(", ")}`)
      if (reviewPacket.verificationCommands.length > 0) lines.push(`   Verification: ${reviewPacket.verificationCommands.join(" && ")}`)
      if (reviewPacket.knownGaps.length > 0) lines.push(`   Known gaps: ${reviewPacket.knownGaps.join("; ")}`)
      if (reviewPacket.confidence) lines.push(`   Confidence: ${reviewPacket.confidence}`)
      if (reviewPacket.warnings.length > 0) lines.push(`   Review warnings: ${reviewPacket.warnings.join("; ")}`)
    }

    metadataTasks.push({
      taskID: task.id,
      title: task.title,
      status: task.status,
      assignedTo: task.assigned_engineer_id,
      fileScope,
      coordinationWarnings,
      reviewPacket,
    })
  }

  lines.push("")
  lines.push("To claim a task: team_claim with taskID")

  return {
    output: lines.join("\n"),
    metadataTasks,
  }
}

export * as TeamTaskList from "./task-list"
