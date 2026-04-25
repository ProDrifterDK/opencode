import type { Task } from "./task-board.sql"
import type { EngineerSlot } from "./session-coordinator"

export interface DissolveSummaryInput {
  teamID: string
  /**
   * Tasks snapshot taken BEFORE archive — must include completed/failed/pending
   * states. Pulled from `taskBoard.list({ team_id })` while the rows are still
   * un-archived (i.e. before `dissolveTeam`).
   */
  tasks: ReadonlyArray<Task>
  /**
   * Engineer slots snapshot taken BEFORE dissolve — captures the final
   * state and current task before the rows are deleted.
   */
  engineers: ReadonlyArray<EngineerSlot>
  /**
   * Wall-clock duration from `team_create` to `team_dissolve`, in
   * milliseconds. Computed from `getTeam(teamID).createdAt` at dissolve
   * time.
   */
  durationMs: number
  /**
   * ISO-8601 timestamp when the dissolve was processed. Defaults to
   * `new Date().toISOString()` when omitted; explicit value lets tests
   * pin a deterministic timestamp.
   */
  dissolvedAt?: string
}

const REPORT_TRUNCATE_LIMIT = 200

const formatDuration = (ms: number): string => {
  if (ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const truncateReport = (text: string): string => {
  if (text.length <= REPORT_TRUNCATE_LIMIT) return text
  return text.slice(0, REPORT_TRUNCATE_LIMIT).trimEnd() + "…"
}

const escapeMd = (raw: string): string => {
  // Strip newlines and stray pipe characters so a single bullet stays on
  // one line and the markdown structure isn't disrupted by user-provided
  // task titles.
  return raw.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim()
}

const isoOrUnknown = (ts: number | null | undefined): string =>
  ts && ts > 0 ? new Date(ts).toISOString() : "unknown"

export function buildDissolveSummary(input: DissolveSummaryInput): string {
  const { teamID, tasks, engineers, durationMs } = input
  const dissolvedAt = input.dissolvedAt ?? new Date().toISOString()

  // Bucket tasks by outcome
  const completed = tasks.filter((t) => t.status === "completed")
  const failed = tasks.filter((t) => t.status === "failed")
  const pendingOrBlocked = tasks.filter(
    (t) => t.status === "pending" || t.status === "blocked" || t.status === "in-progress",
  )

  // Count tasks worked per engineer (assigned to them, regardless of outcome)
  const tasksPerEngineer = new Map<string, number>()
  for (const t of tasks) {
    if (!t.assigned_engineer_id) continue
    const id = t.assigned_engineer_id as string
    tasksPerEngineer.set(id, (tasksPerEngineer.get(id) ?? 0) + 1)
  }

  // Map engineerID → name for nicer rendering in task lists
  const engineerNameById = new Map<string, string>()
  for (const e of engineers) {
    engineerNameById.set(e.engineerID as string, e.name)
  }

  const lines: string[] = []
  lines.push(`# Team Dissolve Summary — ${teamID}`)
  lines.push("")
  lines.push(`**Dissolved**: ${dissolvedAt}`)
  lines.push(`**Duration**: ${formatDuration(durationMs)} from team_create`)
  lines.push(`**Engineers**: ${engineers.length}`)
  lines.push(`**Tasks total**: ${tasks.length}`)
  lines.push("")

  // ── Tasks section ───────────────────────────────────────────────────────
  lines.push("## Tasks")
  lines.push("")

  lines.push(`### Completed (${completed.length})`)
  if (completed.length === 0) {
    lines.push("- _none_")
  } else {
    for (const t of completed) {
      const engName = t.assigned_engineer_id
        ? (engineerNameById.get(t.assigned_engineer_id as string) ?? (t.assigned_engineer_id as string))
        : "unassigned"
      lines.push(
        `- "${escapeMd(t.title)}" — ${engName} — completed at ${isoOrUnknown(t.completed_at)}`,
      )
    }
  }
  lines.push("")

  lines.push(`### Failed (${failed.length})`)
  if (failed.length === 0) {
    lines.push("- _none_")
  } else {
    for (const t of failed) {
      const engName = t.assigned_engineer_id
        ? (engineerNameById.get(t.assigned_engineer_id as string) ?? (t.assigned_engineer_id as string))
        : "unassigned"
      const errMsg = t.description ? escapeMd(t.description) : "(no error captured)"
      lines.push(`- "${escapeMd(t.title)}" — ${engName} — error: ${errMsg}`)
    }
  }
  lines.push("")

  lines.push(`### Pending/blocked at dissolve (${pendingOrBlocked.length})`)
  if (pendingOrBlocked.length === 0) {
    lines.push("- _none_")
  } else {
    for (const t of pendingOrBlocked) {
      lines.push(`- "${escapeMd(t.title)}" — status: ${t.status}`)
    }
  }
  lines.push("")

  // ── Engineers section ───────────────────────────────────────────────────
  lines.push("## Engineers")
  lines.push("")

  if (engineers.length === 0) {
    lines.push("_No engineers were spawned for this team._")
    lines.push("")
  } else {
    for (const e of engineers) {
      const agent = e.agentName ?? "(no agent)"
      const color = e.agentColor ?? "(no color)"
      lines.push(`### ${e.name} (${agent}, ${color})`)
      lines.push(`- State at dissolve: ${e.state}`)
      lines.push(`- Tasks worked: ${tasksPerEngineer.get(e.engineerID as string) ?? 0}`)
      const report = e.currentTask ? truncateReport(escapeMd(e.currentTask)) : "(none)"
      lines.push(`- Last report: ${report}`)
      lines.push("")
    }
  }

  return lines.join("\n").trimEnd() + "\n"
}
