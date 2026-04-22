import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionCoordinator } from "../team"
import { LeadCoordinator } from "../team"
import { TaskBoardRepo } from "../team"
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

// Suppress unused warning for translatePriority (reserved for mailbox priority mapping)
void (translatePriority as unknown)
