import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionCoordinator } from "../team"
import { LeadCoordinator } from "../team"
import { TeamID } from "../team/types"
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

// Suppress unused warning for translatePriority (reserved for mailbox priority mapping)
void (translatePriority as unknown)
