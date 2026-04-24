import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionCoordinator } from "../team/session-coordinator"
import { LeadCoordinator } from "../team/lead-coordinator"
import { TaskBoardRepo } from "../team/task-board"
import { Mailbox } from "../team/mailbox"
import { TeamID } from "../team/types"
import type { EngineerStateRecord } from "../team/types"
import { Event, publishTeamEvent } from "../team/events"
import DESCRIPTION from "./team.txt"

// Priority translation: 4-tier (tool) -> 3-tier (mailbox)
type ToolPriority = "low" | "normal" | "high" | "urgent"
type MailboxPriority = "urgent" | "inbox" | "queue"

function translatePriority(priority: ToolPriority): MailboxPriority {
  switch (priority) {
    case "urgent":
      return "urgent"
    case "high":
      return "inbox"
    case "normal":
      return "inbox"
    case "low":
      return "queue"
  }
}

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        goal: z.string().describe("The goal or mission for the team to accomplish"),
      }),
      execute: (params: { goal: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (isLead) {
            return yield* Effect.fail(new Error("A team already exists for this session"))
          }

          const teamID = TeamID.ascending()
          const record = yield* coordinator.createTeam({
            teamID,
            leadSessionID: ctx.sessionID,
            goal: params.goal,
          })

          const output = [
            `Team created successfully.`,
            `Team ID: ${record.teamID}`,
            `Lead Session: ${record.leadSessionID}`,
            `Goal: ${params.goal}`,
            `State: ${record.state}`,
          ].join("\n")

          return {
            title: `Create team`,
            output,
            metadata: {
              teamID: record.teamID,
              leadSessionID: record.leadSessionID,
              state: record.state,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TeamMonitorTool = Tool.define(
  "team_monitor",
  Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const mailbox = yield* Mailbox.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        teamID: z.string().describe("The team ID to monitor"),
      }),
      execute: (params: { teamID: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const report = yield* lead.monitor(teamID)
          const formatted = lead.formatStatus(report)

          // Fetch and consume unread messages for the lead
          const messages = yield* mailbox.receive(ctx.sessionID)
          let output = formatted

          if (messages.length > 0) {
            const msgLines: string[] = ["\n  📬 Inbox:"]
            for (const msg of messages) {
              const priority = msg.priority === "urgent" ? "🚨" : msg.priority === "inbox" ? "📩" : "📭"
              msgLines.push(`    ${priority} ${msg.content}`)
            }
            output += msgLines.join("\n")
          }

          return {
            title: `Monitor team ${params.teamID}`,
            output,
            metadata: {
              teamID: params.teamID,
              totalTasks: report.totalTasks,
              completed: report.completed,
              pending: report.pending,
              inProgress: report.inProgress,
              failed: report.failed,
              blocked: report.blocked,
              unreadMessages: messages.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamSpawnParams = z.object({
  teamID: z.string().describe("Team ID from team_create"),
  name: z.string().describe("Engineer name (e.g., 'engineer-auth')"),
  task: z.object({
    title: z.string().describe("Task title"),
    description: z.string().describe("Task description"),
    fileScope: z.array(z.string()).optional().describe("Files this task may modify"),
  }),
  model: z.object({
    providerID: z.string().describe("Provider ID (e.g., 'anthropic', 'openai')"),
    modelID: z.string().describe("Model ID (e.g., 'claude-sonnet-4-20250514', 'gpt-4o')"),
  }).optional().describe("Optional LLM model for this engineer. Defaults to current session's model."),
})

export const TeamSpawnTool = Tool.define(
  "team_spawn",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: teamSpawnParams,
      execute: (params: z.infer<typeof teamSpawnParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can spawn engineers"))
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const engineerSlot = yield* coordinator.spawnEngineer({
            teamID,
            leadSessionID: ctx.sessionID,
            name: params.name,
          })

          const fileScope = params.task.fileScope
            ? JSON.stringify(params.task.fileScope)
            : null

          const task = yield* taskBoard.create({
            team_id: teamID,
            title: params.task.title,
            description: params.task.description,
            status: "in-progress",
            assigned_engineer_id: engineerSlot.engineerID,
            file_scope: fileScope,
          })

          yield* coordinator.updateEngineer(engineerSlot.engineerID, {
            state: "working",
            currentTask: task.id,
          })

          // Publish event to trigger the Team Daemon to start the engineer's loop
          publishTeamEvent(Event.EngineerSpawned, {
            teamID,
            engineerID: engineerSlot.engineerID,
            sessionID: engineerSlot.sessionID,
            name: params.name,
            state: "working",
            taskID: task.id,
            taskTitle: params.task.title,
            taskDescription: params.task.description,
            providerID: params.model?.providerID,
            modelID: params.model?.modelID,
          })

          const modelInfo = params.model
            ? `Model: ${params.model.providerID}/${params.model.modelID}`
            : "Model: (session default)"

          const output = [
            `Engineer spawned successfully.`,
            `Engineer ID: ${engineerSlot.engineerID}`,
            `Session ID: ${engineerSlot.sessionID}`,
            `Task ID: ${task.id}`,
            `Task: ${params.task.title}`,
            modelInfo,
            ``,
            `Note: Do NOT poll team_monitor. Engineer will notify you when done.`,
          ].join("\n")

          return {
            title: `Spawn engineer ${params.name}`,
            output,
            metadata: {
              engineerID: engineerSlot.engineerID,
              sessionID: engineerSlot.sessionID,
              taskID: task.id,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamAssignParams = z.object({
  teamID: z.string().describe("Team ID"),
})

export const TeamAssignTool = Tool.define(
  "team_assign",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service

    return {
      description: DESCRIPTION,
      parameters: teamAssignParams,
      execute: (params: z.infer<typeof teamAssignParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can assign tasks"))
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const slots = yield* coordinator.listTeamEngineers(teamID)

          const engineers = slots as unknown as EngineerStateRecord[]

          const assigned = yield* lead.assign({ teamId: teamID, engineers })

          for (const task of assigned) {
            if (task.assigned_engineer_id) {
              yield* coordinator.updateEngineer(task.assigned_engineer_id, {
                state: "working",
                currentTask: task.id,
              })
            }
          }

          const output = [
            `Tasks assigned: ${assigned.length}`,
            ...assigned.map((t) => `  - ${t.title} → engineer ${t.assigned_engineer_id}`),
          ].join("\n")

          return {
            title: `Assign tasks for team ${params.teamID}`,
            output,
            metadata: {
              assignedCount: assigned.length,
              assigned: assigned.map((t) => ({
                taskID: t.id,
                title: t.title,
                engineerID: t.assigned_engineer_id,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamDecomposeParams = z.object({
  teamID: z.string().describe("Team ID"),
  subtasks: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).default([]),
      }),
    )
    .describe("Subtasks to create (pre-parsed by LLM)"),
})

export const TeamDecomposeTool = Tool.define(
  "team_decompose",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service

    return {
      description: DESCRIPTION,
      parameters: teamDecomposeParams,
      execute: (params: z.infer<typeof teamDecomposeParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can decompose tasks"))
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const tasks = yield* lead.decompose({
            teamId: teamID,
            subtasks: params.subtasks,
            request: `Decomposed into ${params.subtasks.length} subtasks`,
          })

          const output = [
            `Tasks created: ${tasks.length}`,
            ...tasks.map((t) => `  - ${t.title}`),
          ].join("\n")

          return {
            title: `Decompose team ${params.teamID}`,
            output,
            metadata: {
              taskCount: tasks.length,
              tasks: tasks.map((t) => ({ taskID: t.id, title: t.title })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamReassignParams = z.object({
  taskID: z.string().describe("Task ID to reassign"),
  toEngineerID: z.string().describe("Target engineer ID"),
})

export const TeamReassignTool = Tool.define(
  "team_reassign",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service

    return {
      description: DESCRIPTION,
      parameters: teamReassignParams,
      execute: (params: z.infer<typeof teamReassignParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can reassign tasks"))
          }

          const task = yield* lead.reassign({
            taskId: params.taskID as import("../team/task-board.sql").TaskBoardID,
            toEngineer: params.toEngineerID as import("../team/types").EngineerID,
          })

          yield* coordinator.updateEngineer(
            params.toEngineerID as import("../team/types").EngineerID,
            { state: "working", currentTask: task.id },
          )

          const output = [
            `Task reassigned successfully.`,
            `Task ID: ${task.id}`,
            `Task: ${task.title}`,
            `Assigned to engineer: ${params.toEngineerID}`,
          ].join("\n")

          return {
            title: `Reassign task ${params.taskID}`,
            output,
            metadata: {
              taskID: task.id,
              title: task.title,
              toEngineerID: params.toEngineerID,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamKillParams = z.object({
  engineerID: z.string().describe("Engineer ID to terminate"),
})

export const TeamKillTool = Tool.define(
  "team_kill",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: teamKillParams,
      execute: (params: z.infer<typeof teamKillParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can kill engineers"))
          }

          const engineerID = params.engineerID as import("../team/types").EngineerID
          const engineer = yield* coordinator.getEngineer(engineerID)
          if (!engineer) {
            return yield* Effect.fail(new Error(`Engineer ${params.engineerID} not found`))
          }

          const teamID = engineer.teamID as ReturnType<typeof TeamID.ascending>
          const tasks = yield* taskBoard.list({
            team_id: teamID,
            assigned_engineer_id: engineerID,
          })

          const inProgressTasks = tasks.filter((t) => t.status === "in-progress")
          for (const task of inProgressTasks) {
            yield* taskBoard.update(task.id, {
              status: "pending",
              assigned_engineer_id: null,
            })
          }

          yield* coordinator.killEngineer({ engineerID, teamID })

          const output = [
            `Engineer ${params.engineerID} terminated.`,
            `Tasks returned to pending: ${inProgressTasks.length}`,
          ].join("\n")

          return {
            title: `Kill engineer ${params.engineerID}`,
            output,
            metadata: {
              engineerID: params.engineerID,
              tasksReassigned: inProgressTasks.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamMessageParams = z.object({
  recipientID: z.string().describe("Engineer ID, or 'lead' to message the lead"),
  content: z.string().describe("Message content"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
})

export const TeamMessageTool = Tool.define(
  "team_message",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const mailbox = yield* Mailbox.Service

    return {
      description: DESCRIPTION,
      parameters: teamMessageParams,
      execute: (params: z.infer<typeof teamMessageParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const teamID = yield* coordinator.getTeamForSession(ctx.sessionID)
          if (!teamID) {
            return yield* Effect.fail(new Error("Not part of a team"))
          }

          let recipientSessionID: import("../session/schema").SessionID
          if (params.recipientID === "lead") {
            const team = yield* coordinator.getTeam(teamID)
            if (!team) {
              return yield* Effect.fail(new Error("Team not found"))
            }
            recipientSessionID = team.leadSessionID
          } else {
            const recipientEngineerID = params.recipientID as import("../team/types").EngineerID
            const recipient = yield* coordinator.getEngineer(recipientEngineerID)
            if (!recipient) {
              return yield* Effect.fail(new Error(`Engineer ${params.recipientID} not found`))
            }
            if (recipient.teamID !== teamID) {
              return yield* Effect.fail(
                new Error(`Cannot message ${params.recipientID}: not in your team`),
              )
            }
            recipientSessionID = recipient.sessionID
          }

          const mailboxPriority = translatePriority(params.priority)
          const message = yield* mailbox.send({
            recipientSessionID,
            senderSessionID: ctx.sessionID,
            priority: mailboxPriority,
            type: "team_message",
            content: params.content,
          })

          const output = [
            `Message sent successfully.`,
            `Message ID: ${message.id}`,
            `Recipient: ${params.recipientID}`,
            `Priority: ${params.priority}`,
          ].join("\n")

          return {
            title: `Message to ${params.recipientID}`,
            output,
            metadata: {
              messageID: message.id,
              recipientID: params.recipientID,
              priority: params.priority,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamStatusParams = z.object({
  state: z.enum(["working", "blocked", "completed"]).describe("Current state"),
  progress: z.string().optional().describe("Progress description"),
  blocker: z.string().optional().describe("Blocker description if blocked"),
})

export const TeamStatusTool = Tool.define(
  "team_status",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: teamStatusParams,
      execute: (params: z.infer<typeof teamStatusParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isEngineer = yield* coordinator.isEngineer(ctx.sessionID)
          if (!isEngineer) {
            return yield* Effect.fail(new Error("Only engineers can report status"))
          }

          const engineer = yield* coordinator.getEngineerBySession(ctx.sessionID)
          if (!engineer) {
            return yield* Effect.fail(new Error("Engineer session not found"))
          }

          const engineerState =
            params.state === "completed"
              ? ("idle" as const)
              : params.state === "blocked"
                ? ("blocked" as const)
                : ("working" as const)

          yield* coordinator.updateEngineer(engineer.engineerID, {
            state: engineerState,
            lastHeartbeat: Date.now(),
          })

          // Publish progress event for UI updates
          if (params.progress) {
            publishTeamEvent(Event.EngineerProgress, {
              teamID: engineer.teamID,
              engineerID: engineer.engineerID,
              progressText: params.progress,
              timestamp: Date.now(),
            })
          }

          if (engineer.currentTask) {
            const taskID = engineer.currentTask as import("../team/task-board.sql").TaskBoardID
            const taskStatus =
              params.state === "completed"
                ? "completed"
                : params.state === "blocked"
                  ? "blocked"
                  : "in-progress"

            yield* taskBoard.update(taskID, { status: taskStatus })

            if (params.state === "completed") {
              yield* coordinator.updateEngineer(engineer.engineerID, {
                currentTask: null,
              })
            }
          }

          const output = [
            `Status updated.`,
            `State: ${params.state}`,
            params.progress ? `Progress: ${params.progress}` : null,
            params.blocker ? `Blocker: ${params.blocker}` : null,
          ]
            .filter(Boolean)
            .join("\n")

          return {
            title: `Status: ${params.state}`,
            output,
            metadata: {
              state: params.state,
              engineerID: engineer.engineerID,
              currentTask: engineer.currentTask ?? null,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamDissolveParams = z.object({
  teamID: z.string().describe("Team ID to dissolve"),
  force: z.boolean().default(false).describe("Force dissolve even with in-progress tasks"),
})

export const TeamDissolveTool = Tool.define(
  "team_dissolve",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: teamDissolveParams,
      execute: (params: z.infer<typeof teamDissolveParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can dissolve a team"))
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const report = yield* lead.monitor(teamID)

          if (report.inProgress > 0 && !params.force) {
            return yield* Effect.fail(
              new Error(
                `Cannot dissolve: ${report.inProgress} tasks in progress. Use force=true to terminate immediately.`,
              ),
            )
          }

          const engineers = yield* coordinator.listTeamEngineers(teamID)
          const engineerCount = engineers.length

          if (params.force) {
            const allTasks = yield* taskBoard.list({ team_id: teamID })
            const inProgressTasks = allTasks.filter((t) => t.status === "in-progress")
            for (const task of inProgressTasks) {
              yield* taskBoard.update(task.id, { status: "failed" })
            }
          }

          yield* coordinator.dissolveTeam({ teamID })

          const output = [
            `Team ${params.teamID} dissolved.`,
            `Engineers terminated: ${engineerCount}`,
          ].join("\n")

          return {
            title: `Dissolve team ${params.teamID}`,
            output,
            metadata: {
              teamID: params.teamID,
              engineersTerminated: engineerCount,
              forced: params.force,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const teamReportParams = z.object({
  status: z.enum(["completed", "blocked", "failed"]).describe("Task completion status"),
  summary: z.string().describe("Brief summary of work done or reason for failure/block"),
})

export const TeamReportTool = Tool.define(
  "team_report",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service
    const mailbox = yield* Mailbox.Service

    return {
      description: DESCRIPTION,
      parameters: teamReportParams,
      execute: (params: z.infer<typeof teamReportParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isEngineer = yield* coordinator.isEngineer(ctx.sessionID)
          if (!isEngineer) {
            return yield* Effect.fail(new Error("Only engineers can report task completion"))
          }

          const engineer = yield* coordinator.getEngineerBySession(ctx.sessionID)
          if (!engineer) {
            return yield* Effect.fail(new Error("Engineer not found"))
          }

          if (!engineer.currentTask) {
            return yield* Effect.fail(new Error("No task assigned to this engineer"))
          }

          const taskID = engineer.currentTask
          const task = yield* taskBoard.get(taskID)
          const taskTitle = task?.title ?? taskID

          yield* taskBoard.update(taskID, {
            status: params.status,
          })

          const newState = params.status === "completed" ? "idle" : params.status === "blocked" ? "blocked" : "failed"
          yield* coordinator.updateEngineer(engineer.engineerID, {
            state: newState,
            currentTask: null,
          })

          // Publish progress event with status summary for sidebar
          const statusEmoji = params.status === "completed" ? "✅" : params.status === "blocked" ? "🚧" : "❌"
          publishTeamEvent(Event.EngineerProgress, {
            teamID: engineer.teamID,
            engineerID: engineer.engineerID,
            progressText: `${statusEmoji} ${params.status}: ${params.summary.slice(0, 50)}${params.summary.length > 50 ? "..." : ""}`,
            timestamp: Date.now(),
          })

          // Publish completion/failure event for UI
          if (params.status === "completed") {
            publishTeamEvent(Event.EngineerCompleted, {
              teamID: engineer.teamID,
              engineerID: engineer.engineerID,
              taskId: taskID,
            })
          } else if (params.status === "failed") {
            publishTeamEvent(Event.EngineerFailed, {
              teamID: engineer.teamID,
              engineerID: engineer.engineerID,
              taskId: taskID,
              error: params.summary,
            })
          }

          // Send message to lead to notify them
          const team = yield* coordinator.getTeam(engineer.teamID)
          if (team) {
            const statusEmoji = params.status === "completed" ? "✅" : params.status === "blocked" ? "🚧" : "❌"
            const message = [
              `${statusEmoji} Engineer ${engineer.name} reports: ${params.status.toUpperCase()}`,
              `Task: ${taskTitle}`,
              `Summary: ${params.summary}`,
            ].join("\n")

            yield* mailbox.send({
              senderSessionID: ctx.sessionID,
              recipientSessionID: team.leadSessionID,
              type: "team_report",
              content: message,
              priority: params.status === "failed" ? "urgent" : "inbox",
            })
          }

          const output = [
            `Task reported as ${params.status}.`,
            `Task ID: ${taskID}`,
            `Summary: ${params.summary}`,
            ``,
            `Lead has been notified. You can now stand by for further instructions.`,
          ].join("\n")

          return {
            title: `Report task ${params.status}`,
            output,
            metadata: {
              taskID,
              status: params.status,
              engineerID: engineer.engineerID,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ─── Team Inbox Tool (lightweight mailbox check) ────────────────────────────

export const TeamInboxTool = Tool.define(
  "team_inbox",
  Effect.gen(function* () {
    const mailbox = yield* Mailbox.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        peek: z.boolean().optional().describe("If true, preview messages without marking as read"),
      }),
      execute: (params: { peek?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const messages = params.peek
            ? yield* mailbox.peek(ctx.sessionID)
            : yield* mailbox.receive(ctx.sessionID)

          const unread = messages.filter((m) => !m.read_at)

          if (unread.length === 0) {
            return {
              title: "Check inbox",
              output: "📭 No new messages.",
              metadata: { messageCount: 0 },
            }
          }

          const lines: string[] = [`📬 ${unread.length} message(s):`]
          for (const msg of unread) {
            const priority = msg.priority === "urgent" ? "🚨" : msg.priority === "inbox" ? "📩" : "📭"
            lines.push(`  ${priority} ${msg.content}`)
          }

          return {
            title: "Check inbox",
            output: lines.join("\n"),
            metadata: {
              messageCount: unread.length,
              messages: unread.map((m) => ({
                id: m.id,
                priority: m.priority,
                from: m.sender_session_id,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ─── Team Roster Tool (discover teammates) ─────────────────────────────────

export const TeamRosterTool = Tool.define(
  "team_roster",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: Record<string, never>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const teamID = yield* coordinator.getTeamForSession(ctx.sessionID)
          if (!teamID) {
            return yield* Effect.fail(new Error("Not part of a team"))
          }

          const team = yield* coordinator.getTeam(teamID)
          const engineers = yield* coordinator.listTeamEngineers(teamID)
          const myEngineer = yield* coordinator.getEngineerBySession(ctx.sessionID)
          const myID = myEngineer?.engineerID

          const lines: string[] = [
            `Team: ${teamID}`,
            `Goal: ${team?.goal ?? "N/A"}`,
            ``,
            `Teammates:`,
          ]

          for (const eng of engineers) {
            const isMe = eng.engineerID === myID
            const stateEmoji = eng.state === "working" ? "🔨" : eng.state === "idle" ? "💤" : eng.state === "blocked" ? "🚧" : "❌"
            lines.push(`  ${stateEmoji} ${eng.name}${isMe ? " (you)" : ""} - ID: ${eng.engineerID}`)
            if (eng.currentTask) {
              lines.push(`      Task: ${eng.currentTask}`)
            }
          }

          lines.push(``)
          lines.push(`To message a teammate: team_message with recipientID set to their ID`)
          lines.push(`To message the lead: team_message with recipientID set to "lead"`)

          return {
            title: "Team roster",
            output: lines.join("\n"),
            metadata: {
              teamID,
              engineerCount: engineers.length,
              engineers: engineers.map((e) => ({
                engineerID: e.engineerID,
                name: e.name,
                state: e.state,
                isMe: e.engineerID === myID,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ─── Team Tasks Tool (list available tasks) ────────────────────────────────

export const TeamTasksTool = Tool.define(
  "team_tasks",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        showAll: z.boolean().optional().describe("Show all tasks including assigned ones (default: only unassigned)"),
      }),
      execute: (params: { showAll?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const teamID = yield* coordinator.getTeamForSession(ctx.sessionID)
          if (!teamID) {
            return yield* Effect.fail(new Error("Not part of a team"))
          }

          const allTasks = yield* taskBoard.list({ team_id: teamID })
          const tasks = params.showAll
            ? allTasks
            : allTasks.filter((t) => t.status === "pending" && !t.assigned_engineer_id)

          if (tasks.length === 0) {
            return {
              title: "Available tasks",
              output: params.showAll
                ? "No tasks in the team."
                : "No unassigned tasks available. Use showAll=true to see all tasks.",
              metadata: { taskCount: 0, tasks: [] },
            }
          }

          const lines: string[] = [
            params.showAll ? "All tasks:" : "Available tasks (pending, unassigned):",
            "",
          ]

          for (const task of tasks) {
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
          }

          lines.push("")
          lines.push("To claim a task: team_claim with taskID")

          return {
            title: "Available tasks",
            output: lines.join("\n"),
            metadata: {
              taskCount: tasks.length,
              tasks: tasks.map((t) => ({
                taskID: t.id,
                title: t.title,
                status: t.status,
                assignedTo: t.assigned_engineer_id,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ─── Team Claim Tool (claim a task) ─────────────────────────────────────────

const teamClaimParams = z.object({
  taskID: z.string().describe("Task ID to claim (from team_tasks)"),
})

export const TeamClaimTool = Tool.define(
  "team_claim",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: DESCRIPTION,
      parameters: teamClaimParams,
      execute: (params: z.infer<typeof teamClaimParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isEngineer = yield* coordinator.isEngineer(ctx.sessionID)
          if (!isEngineer) {
            return yield* Effect.fail(new Error("Only engineers can claim tasks"))
          }

          const engineer = yield* coordinator.getEngineerBySession(ctx.sessionID)
          if (!engineer) {
            return yield* Effect.fail(new Error("Engineer not found"))
          }

          if (engineer.currentTask) {
            return yield* Effect.fail(
              new Error(`You already have a task assigned: ${engineer.currentTask}. Complete it first with team_report.`),
            )
          }

          const taskID = params.taskID as import("../team/task-board.sql").TaskBoardID
          const task = yield* taskBoard.get(taskID)
          if (!task) {
            return yield* Effect.fail(new Error(`Task not found: ${params.taskID}`))
          }

          if (task.team_id !== engineer.teamID) {
            return yield* Effect.fail(new Error("Task belongs to a different team"))
          }

          // Task must be pending AND unassigned to be claimable
          if (task.status !== "pending") {
            return yield* Effect.fail(new Error(`Task is not claimable (status: ${task.status}). Only pending tasks can be claimed.`))
          }

          if (task.assigned_engineer_id) {
            if (task.assigned_engineer_id === engineer.engineerID) {
              return yield* Effect.fail(
                new Error(`This task is already assigned to you. Use team_report to complete it.`),
              )
            }
            return yield* Effect.fail(
              new Error(`Task already claimed by another engineer: ${task.assigned_engineer_id}`),
            )
          }

          // Claim the task
          yield* taskBoard.update(taskID, {
            status: "in-progress",
            assigned_engineer_id: engineer.engineerID,
          })

          yield* coordinator.updateEngineer(engineer.engineerID, {
            state: "working",
            currentTask: taskID,
          })

          // Publish progress event
          publishTeamEvent(Event.EngineerProgress, {
            teamID: engineer.teamID,
            engineerID: engineer.engineerID,
            progressText: `Claimed: ${task.title.slice(0, 40)}${task.title.length > 40 ? "..." : ""}`,
            timestamp: Date.now(),
          })

          publishTeamEvent(Event.TaskAssigned, {
            teamID: engineer.teamID,
            taskId: taskID,
            engineerID: engineer.engineerID,
          })

          const output = [
            `Task claimed successfully!`,
            ``,
            `Task ID: ${taskID}`,
            `Title: ${task.title}`,
            task.description ? `Description: ${task.description}` : null,
            task.file_scope ? `File scope: ${task.file_scope}` : null,
            ``,
            `Start working on this task. When done, call team_report.`,
          ].filter(Boolean).join("\n")

          return {
            title: `Claimed task: ${task.title}`,
            output,
            metadata: {
              taskID,
              title: task.title,
              description: task.description,
              engineerID: engineer.engineerID,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ─── Export all tools ───────────────────────────────────────────────────────

export const TeamTools = Effect.gen(function* () {
  const infos = yield* Effect.all([
    TeamCreateTool,
    TeamSpawnTool,
    TeamDecomposeTool,
    TeamAssignTool,
    TeamReassignTool,
    TeamKillTool,
    TeamMonitorTool,
    TeamMessageTool,
    TeamStatusTool,
    TeamReportTool,
    TeamDissolveTool,
    TeamInboxTool,
    TeamRosterTool,
    TeamTasksTool,
    TeamClaimTool,
  ])
  return yield* Effect.all(infos.map(Tool.init))
})
