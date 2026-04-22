import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionCoordinator } from "../team"
import { LeadCoordinator } from "../team"
import { TaskBoardRepo } from "../team"
import { Mailbox } from "../team"
import { TeamID } from "../team/types"
import type { EngineerStateRecord } from "../team/types"
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

          return {
            title: `Monitor team ${params.teamID}`,
            output: formatted,
            metadata: {
              teamID: params.teamID,
              totalTasks: report.totalTasks,
              completed: report.completed,
              pending: report.pending,
              inProgress: report.inProgress,
              failed: report.failed,
              blocked: report.blocked,
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

          const output = [
            `Engineer spawned successfully.`,
            `Engineer ID: ${engineerSlot.engineerID}`,
            `Session ID: ${engineerSlot.sessionID}`,
            `Task ID: ${task.id}`,
            `Task: ${params.task.title}`,
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

// ─── Export all tools ───────────────────────────────────────────────────────

export const TeamTools = Effect.gen(function* () {
  const tools = yield* Effect.all([
    Tool.init(TeamCreateTool),
    Tool.init(TeamSpawnTool),
    Tool.init(TeamDecomposeTool),
    Tool.init(TeamAssignTool),
    Tool.init(TeamReassignTool),
    Tool.init(TeamKillTool),
    Tool.init(TeamMonitorTool),
    Tool.init(TeamMessageTool),
    Tool.init(TeamStatusTool),
    Tool.init(TeamDissolveTool),
  ])
  return tools
})
