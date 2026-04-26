import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { SessionShare } from "../share"
import { SessionCoordinator } from "../team/session-coordinator"
import { LeadCoordinator } from "../team/lead-coordinator"
import { TaskBoardRepo } from "../team/task-board"
import { Mailbox } from "../team/mailbox"
import { TeamID } from "../team/types"
import type { EngineerStateRecord } from "../team/types"
import { Event, publishTeamEvent } from "../team/events"
import { Provider } from "../provider"
import { TeamDaemon } from "../team/daemon"
import { HeartbeatMonitor } from "../team/heartbeat"
import { GitManager } from "../team/git-manager"
import { Agent } from "../agent/agent"
import { TEAM_AGENTS_CACHE_TTL_MS } from "../team/constants"
import { checkAndRecordMessage } from "../team/message-rate-limiter"
import { Log } from "@/util"
import { buildDissolveSummary } from "../team/dissolve-summary"
import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"

const log = Log.create({ service: "tool.team" })
// Priority translation: 4-tier (tool) -> 3-tier (mailbox).
// Note: `high` and `normal` both collapse to `inbox` — documented design;
// the 4-tier surface is for caller clarity, not distinct delivery semantics.
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

const toolErrorBoundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => console.error("[toolErrorBoundary]", error)),
    ),
  )

// Role guards — previously copy-pasted 13 times.
const requireLead = (ctx: Tool.Context, coordinator: SessionCoordinator.Interface, action = "use this tool") =>
  Effect.gen(function* () {
    const isLead = yield* coordinator.isLead(ctx.sessionID)
    if (!isLead) {
      return yield* Effect.fail(new Error(`Only the team lead can ${action}`))
    }
  })

const requireEngineer = (ctx: Tool.Context, coordinator: SessionCoordinator.Interface, action = "use this tool") =>
  Effect.gen(function* () {
    const isEngineer = yield* coordinator.isEngineer(ctx.sessionID)
    if (!isEngineer) {
      return yield* Effect.fail(new Error(`Only engineers can ${action}`))
    }
  })

// Per-tool descriptions. Previously every tool advertised the full 50-line
// team.txt catalog, bloating the system prompt 16× with identical content.
const TOOL_DESCRIPTIONS = {
  team_create:
    "Initialize a new team for a goal. Returns a teamID used by every later call. Lead-only; called ONCE per team.",
  team_share:
    "Share all session transcripts for the team (Lead + all engineers). Returns a URL for each session. Lead-only.",
  team_agents:
    "List configured agents ({ name, description, ... }). Call this before team_spawn to pick an agent per subtask; match on description, not name. Lead-only.",
  team_spawn:
    "Create an engineer session with a task. REQUIRES an `agent` parameter from team_agents. Lead-only.",
  team_decompose:
    "Break a team goal into subtasks with non-overlapping file scopes. Annotate `complexity` per subtask (low/medium/high) to help match to faster agents in heterogeneous teams. Lead-only.",
  team_assign:
    "Auto-assign pending tasks to idle engineers using file-scope matching. Lead-only.",
  team_reassign: "Move a task from one engineer to another. Lead-only.",
  team_retask:
    "Edit a pending or blocked task's title, description, or fileScope. At least one field must be provided. Rejects in-progress, completed, and failed tasks. Checks glob overlap against other active tasks when fileScope changes. Lead-only.",
  team_kill:
    "Terminate a single engineer session and release its task to pending. Lead-only.",
  team_monitor:
    "Aggregate progress report for a team. Call on-demand only — do NOT poll; engineers notify the lead through team_inbox.",
  team_inbox: "Read unread messages addressed to you (fast, no aggregate status).",
  team_message:
    "Send a message to another session. Recipient is an engineer ID or 'lead'.",
  team_roster:
    "List all teammates with IDs and current state. Use before team_message to resolve engineer IDs.",
  team_tasks: "List pending, unassigned tasks that can be claimed.",
  team_claim: "Claim an unassigned task to start working on it. Engineer-only.",
  team_status: "Report current state and progress. Engineer-only.",
  team_report:
    "Report task completion, failure, or blocked status. Engineer-only; required at end of a task.",
  team_dissolve:
    "Gracefully shut down a team when all tasks are complete. Lead-only.",
  team_resume:
    "Re-attach a team that was left in `terminated` state (daemon shut down before dissolve). Re-spawns engineer subprocesses for active tasks and resets any in-progress tasks back to pending. Lead-only.",
  team_commit:
    "Squash-merge each completed engineer's branch into the lead's current branch using the engineer's task title as the commit message. Conflicts are surfaced and require manual resolution. Lead-only.",
} as const

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const daemon = yield* TeamDaemon.Service
    const heartbeatMonitor = yield* HeartbeatMonitor.Service

    return {
      description: TOOL_DESCRIPTIONS.team_create,
      parameters: z.object({
        goal: z.string().describe("The goal or mission for the team to accomplish"),
      }),
      execute: (params: { goal: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (isLead) {
            return yield* Effect.fail(new Error("A team already exists for this session"))
          }

          // Start the team daemon (ensures event subscriptions are active)
          yield* daemon.start()

          const teamID = TeamID.ascending()
          const record = yield* coordinator.createTeam({
            teamID,
            leadSessionID: ctx.sessionID,
            goal: params.goal,
          })

          yield* heartbeatMonitor.startTeamMonitoring(record.teamID, record.leadSessionID).pipe(
            Effect.catch((err) =>
              Effect.sync(() =>
                log.warn("failed to start heartbeat monitoring", {
                  teamID: record.teamID,
                  error: String(err),
                }),
              ),
            ),
          )

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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

export const TeamMonitorTool = Tool.define(
  "team_monitor",
  Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const mailbox = yield* Mailbox.Service

    return {
      description: TOOL_DESCRIPTIONS.team_monitor,
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
              rateLimits: report.rateLimits ?? null,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
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
  agent: z.string().optional().describe("Agent name to use for this engineer (use team_agents to list). If not specified, uses session's default model."),
  fallbackAgent: z.string().optional().describe("Fallback agent name. If the primary agent's provider trips the team's circuit breaker (sustained 429s), the engineer swaps to this agent and retries the task ONCE. Use a different provider for true cross-provider failover."),
})

export const TeamSpawnTool = Tool.define(
  "team_spawn",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const taskBoard = yield* TaskBoardRepo.Service
    const agentService = yield* Agent.Service

    return {
      description: TOOL_DESCRIPTIONS.team_spawn,
      parameters: teamSpawnParams,
      execute: (params: z.infer<typeof teamSpawnParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can spawn engineers"))
          }

          // Resolve agent (and optional fallback) to get model configuration and color.
          // Both validations consume the E4 _agentsCache so we never double-list().
          let modelConfig: { providerID: string; modelID: string } | undefined
          let agentName: string | undefined
          let agentColor: string | undefined
          let fallbackAgentName: string | undefined
          let fallbackModelConfig: { providerID: string; modelID: string } | undefined

          if (params.agent || params.fallbackAgent) {
            const now = Date.now()
            const agents =
              _agentsCache && _agentsCache.expiresAt > now
                ? _agentsCache.value
                : yield* Effect.gen(function* () {
                    const fresh = yield* agentService.list()
                    _agentsCache = { value: fresh, expiresAt: now + TEAM_AGENTS_CACHE_TTL_MS }
                    return fresh
                  })
            const lookupAgent = (rawName: string, label: "Agent" | "Fallback agent") => {
              const found = agents.find(a => a.name.toLowerCase() === rawName.toLowerCase())
              if (!found) {
                const available = agents
                  .filter(a => !a.hidden && !a.native)
                  .map(a => a.name)
                const availableList = available.length > 0 ? available.join(", ") : "(none configured)"
                return { ok: false as const, error: `${label} '${rawName}' not found. Available: ${availableList}` }
              }
              return { ok: true as const, agent: found }
            }

            if (params.agent) {
              const r = lookupAgent(params.agent, "Agent")
              if (!r.ok) return yield* Effect.fail(new Error(r.error))
              agentName = r.agent.name
              agentColor = r.agent.color
              if (r.agent.model) {
                modelConfig = {
                  providerID: r.agent.model.providerID,
                  modelID: r.agent.model.modelID,
                }
              }
            }
            if (params.fallbackAgent) {
              const r = lookupAgent(params.fallbackAgent, "Fallback agent")
              if (!r.ok) return yield* Effect.fail(new Error(r.error))
              fallbackAgentName = r.agent.name
              if (r.agent.model) {
                fallbackModelConfig = {
                  providerID: r.agent.model.providerID,
                  modelID: r.agent.model.modelID,
                }
              }
            }
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const engineerSlot = yield* coordinator.spawnEngineer({
            teamID,
            leadSessionID: ctx.sessionID,
            name: params.name,
            agentName,
            agentColor,
            fallbackAgent: fallbackAgentName,
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
            providerID: modelConfig?.providerID,
            modelID: modelConfig?.modelID,
            agentName,
            agentColor,
            fallbackAgent: fallbackAgentName,
            fallbackProviderID: fallbackModelConfig?.providerID,
            fallbackModelID: fallbackModelConfig?.modelID,
          })

          const modelInfo = agentName
            ? `Agent: ${agentName}` + (modelConfig ? ` (${modelConfig.providerID}/${modelConfig.modelID})` : " (session default model)")
            : "Model: (session default)"
          const fallbackInfo = fallbackAgentName
            ? `Fallback: ${fallbackAgentName}` + (fallbackModelConfig ? ` (${fallbackModelConfig.providerID}/${fallbackModelConfig.modelID})` : " (session default model)")
            : null

          const output = [
            `Engineer spawned successfully.`,
            `Engineer ID: ${engineerSlot.engineerID}`,
            `Session ID: ${engineerSlot.sessionID}`,
            `Task ID: ${task.id}`,
            `Task: ${params.task.title}`,
            modelInfo,
            fallbackInfo,
            ``,
            `Note: Do NOT poll team_monitor. Engineer will notify you when done.`,
          ].filter(Boolean).join("\n")

          return {
            title: `Spawn engineer ${params.name}`,
            output,
            metadata: {
              engineerID: engineerSlot.engineerID,
              sessionID: engineerSlot.sessionID,
              taskID: task.id,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_assign,
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

          let output: string
          if (assigned.length === 0) {
            output = "No ready tasks to assign. All pending tasks may be waiting for dependencies to complete, or no idle engineers are available."
          } else {
            output = [
              `Tasks assigned: ${assigned.length}`,
              ...assigned.map((t) => `  - ${t.title} → engineer ${t.assigned_engineer_id}`),
            ].join("\n")
          }

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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

const teamDecomposeParams = z.object({
  teamID: z.string().describe("Team ID"),
  subtasks: z
    .array(
      z.object({
        id: z.string().optional().describe("Optional client-side identifier for dependency references"),
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).default([]),
        dependencies: z
          .array(z.string())
          .optional()
          .describe("IDs of subtasks (from `id` field) that must complete before this one can start"),
        complexity: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Hint for agent routing: low = fast/cheap agent, high = deep/powerful agent"),
      }),
    )
    .describe("Subtasks to create (pre-parsed by LLM). Use `id` + `dependencies` to declare execution order."),
})

export const TeamDecomposeTool = Tool.define(
  "team_decompose",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service

    return {
      description: TOOL_DESCRIPTIONS.team_decompose,
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
            subtasks: params.subtasks.map((s) => ({
              id: s.id,
              title: s.title,
              description: s.description,
              files: s.files,
              dependencies: s.dependencies,
              complexity: s.complexity,
            })),
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
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_reassign,
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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

const teamRetaskParams = z.object({
  taskID: z.string().describe("Task ID to update"),
  title: z.string().optional().describe("New title for the task"),
  description: z.string().optional().describe("New description for the task"),
  fileScope: z.array(z.string()).optional().describe("Replacement file scope for the task"),
})

export const TeamRetaskTool = Tool.define(
  "team_retask",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const lead = yield* LeadCoordinator.Service

    return {
      description: TOOL_DESCRIPTIONS.team_retask,
      parameters: teamRetaskParams,
      execute: (params: z.infer<typeof teamRetaskParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* requireLead(ctx, coordinator, "retask a task")

          const task = yield* lead.retask({
            taskId: params.taskID as import("../team/task-board.sql").TaskBoardID,
            title: params.title,
            description: params.description,
            fileScope: params.fileScope,
          })

          const output = [
            `Task updated successfully.`,
            `Task ID: ${task.id}`,
            `Title: ${task.title}`,
            `Status: ${task.status}`,
          ].join("\n")

          return {
            title: `Retask ${params.taskID}`,
            output,
            metadata: {
              taskID: task.id,
              title: task.title,
              status: task.status,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_kill,
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
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_message,
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

          const rateCheck = checkAndRecordMessage(ctx.sessionID)
          if (!rateCheck.allowed) {
            return {
              title: `Message to ${params.recipientID}`,
              output: `Rate limit exceeded: 10 messages/min per sender. Retry in ~${Math.ceil(rateCheck.retryAfterMs! / 1000)}s.`,
              metadata: { rateLimited: true, messageID: "", recipientID: params.recipientID, priority: params.priority },
            }
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
              rateLimited: false,
              messageID: message.id,
              recipientID: params.recipientID,
              priority: params.priority,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_status,
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
        }).pipe(toolErrorBoundary, Effect.orDie),
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
    const gitManager = yield* GitManager.Service
    const hbMonitor = yield* HeartbeatMonitor.Service

    return {
      description: TOOL_DESCRIPTIONS.team_dissolve,
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

          // Snapshot team metadata + tasks BEFORE archive so the summary
          // sees real status (pending/completed/failed) instead of every
          // row already flipped to "archived".
          const teamRecord = yield* coordinator.getTeam(teamID)
          const teamCreatedAt = teamRecord?.createdAt ?? Date.now()

          if (params.force) {
            const allTasks = yield* taskBoard.list({ team_id: teamID })
            const inProgressTasks = allTasks.filter((t) => t.status === "in-progress")
            for (const task of inProgressTasks) {
              yield* taskBoard.update(task.id, { status: "failed" })
            }
          }

          // Re-read tasks AFTER the force-fail rewrite so the summary
          // reflects the final state the user actually sees.
          const tasksSnapshot = yield* taskBoard.list({ team_id: teamID })

          yield* coordinator.dissolveTeam({ teamID })

          yield* hbMonitor.stopTeamMonitoring(teamID).pipe(Effect.ignore)

          // Delete any team/<teamID>/* git branches that were created for
          // this team. If no branches were created (current behavior, since
          // the daemon does not auto-checkout per engineer) this is a
          // no-op. Git errors are swallowed — the team is logically
          // dissolved regardless of whether branch cleanup succeeds.
const branchCleanup = yield* gitManager
            .cleanupBranches(teamID)
            .pipe(
              Effect.map(() => ({ cleaned: true, error: null as string | null })),
              Effect.tapError((err) =>
                Effect.sync(() => ({ cleaned: false, error: String(err) })),
              ),
              Effect.mapError(() => ({ cleaned: false, error: "cleanup failed" as string | null })),
            )

          // Best-effort markdown summary write. Dissolve must succeed
          // even if the file write fails (read-only fs, permission
          // denied, etc.). We surface the path on success and the
          // error message on failure.
          const dissolvedAtMs = Date.now()
          const summaryMarkdown = buildDissolveSummary({
            teamID: params.teamID,
            tasks: tasksSnapshot,
            engineers,
            durationMs: dissolvedAtMs - teamCreatedAt,
            dissolvedAt: new Date(dissolvedAtMs).toISOString(),
          })

          const summaryRelPath = path.join(".tmp", `team-${params.teamID}-summary.md`)
          const summaryWrite = yield* Effect.try({
            try: () => {
              // Resolve repo root via `git rev-parse --show-toplevel`,
              // falling back to `process.cwd()` outside a repo.
              let repoRoot: string
              try {
                repoRoot = execSync("git rev-parse --show-toplevel", {
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "ignore"],
                }).trim()
              } catch {
                repoRoot = process.cwd()
              }
              const absPath = path.join(repoRoot, summaryRelPath)
              fs.mkdirSync(path.dirname(absPath), { recursive: true })
              fs.writeFileSync(absPath, summaryMarkdown, "utf8")
              return absPath
            },
            catch: (cause) => new Error(String(cause)),
          }).pipe(
            Effect.map((absPath) => ({ ok: true as const, absPath, error: null as string | null })),
            Effect.catch(() => Effect.succeed({ ok: false as const, absPath: null, error: "write failed" as string | null })),
          )

          const lines = [
            summaryWrite.ok
              ? `Team ${params.teamID} dissolved. Summary written to ${summaryRelPath}`
              : `Team ${params.teamID} dissolved. (Summary write failed: ${summaryWrite.error})`,
            `Engineers terminated: ${engineerCount}`,
            branchCleanup.cleaned
              ? `Git branches cleaned.`
              : `Git branch cleanup skipped: ${branchCleanup.error}`,
          ]
          const output = lines.join("\n")

          return {
            title: `Dissolve team ${params.teamID}`,
            output,
            metadata: {
              teamID: params.teamID,
              engineersTerminated: engineerCount,
              forced: params.force,
              summaryPath: summaryWrite.ok ? summaryRelPath : null,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

const teamResumeParams = z.object({
  teamID: z.string().describe("Team ID to resume (must be in `terminated` state)"),
})

export const TeamResumeTool = Tool.define(
  "team_resume",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const daemon = yield* TeamDaemon.Service

    return {
      description: TOOL_DESCRIPTIONS.team_resume,
      parameters: teamResumeParams,
      execute: (params: z.infer<typeof teamResumeParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Resume is invoked from a fresh lead session that may not yet
          // be registered as the lead of the team being resumed. We
          // therefore do NOT require `isLead(ctx.sessionID)` — instead
          // we accept the call and let `coordinator.resumeTeam` enforce
          // state machine correctness (only `terminated` teams are
          // resumable). The teamID parameter itself is the
          // authorization boundary.
          void ctx

          // Ensure the daemon is running so heartbeat + event subscriptions are live.
          yield* daemon.start()

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const resumed = yield* coordinator.resumeTeam(teamID)
          const result = yield* daemon.resumeTeamMonitoring(teamID)

          const output = [
            `Team ${params.teamID} resumed.`,
            `Engineers re-spawned: ${result.respawned}`,
            `Tasks reset to pending: ${result.tasksReset}`,
            `Total engineer slots: ${resumed.engineers.length}`,
          ].join("\n")

          return {
            title: `Resume team ${params.teamID}`,
            output,
            metadata: {
              teamID: params.teamID,
              respawned: result.respawned,
              tasksReset: result.tasksReset,
              engineerCount: resumed.engineers.length,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

const teamCommitParams = z.object({
  teamID: z.string().describe("Team ID from team_create"),
})

export const TeamCommitTool = Tool.define(
  "team_commit",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const gitManager = yield* GitManager.Service
    const taskBoard = yield* TaskBoardRepo.Service

    return {
      description: TOOL_DESCRIPTIONS.team_commit,
      parameters: teamCommitParams,
      execute: (params: z.infer<typeof teamCommitParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const isLead = yield* coordinator.isLead(ctx.sessionID)
          if (!isLead) {
            return yield* Effect.fail(new Error("Only the lead can commit team work"))
          }

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>

          // Fetch all tasks for the team and find completed ones with an assigned engineer
          const allTasks = yield* taskBoard.list({ team_id: teamID })
          const completedTasks = allTasks.filter(
            (t) => t.status === "completed" && t.assigned_engineer_id !== null,
          )

          // Also check engineers listed on the team to handle the "skipped" reporting
          const engineers = yield* coordinator.listTeamEngineers(teamID)

          const merged: { engineerID: string; taskTitle: string }[] = []
          const conflicts: { engineerID: string; branch: string; files: readonly string[] }[] = []
          const skipped: { engineerID: string; reason: string }[] = []

          // Collect engineers that are not idle/completed for the skipped list
          for (const eng of engineers) {
            if (eng.state !== "idle") {
              const stateLabel =
                eng.state === "working"
                  ? "still running"
                  : eng.state === "blocked"
                    ? "blocked"
                    : "failed"
              skipped.push({ engineerID: eng.engineerID, reason: stateLabel })
            }
          }

          // Process completed tasks — stop on first conflict
          for (const task of completedTasks) {
            const engineerID = task.assigned_engineer_id!

            const mergeResult = yield* gitManager
              .mergeBranch({
                teamID,
                engineerID: engineerID as import("../team/types").EngineerID,
                message: task.title,
              })
              .pipe(
                Effect.map(() => ({ ok: true as const })),
                Effect.catchTag("MergeConflictError", (err) =>
                  Effect.succeed({
                    ok: false as const,
                    branch: err.branch,
                    files: err.conflictingFiles,
                  }),
                ),
              )

            if (mergeResult.ok) {
              merged.push({ engineerID, taskTitle: task.title })
            } else {
              conflicts.push({ engineerID, branch: mergeResult.branch, files: mergeResult.files })
              // Stop on first conflict — predictable behavior; user resolves and re-runs
              break
            }
          }

          const lines: string[] = []

          if (merged.length === 0 && completedTasks.length === 0) {
            lines.push("No engineers with completed tasks to merge.")
          } else {
            lines.push(`Merged ${merged.length} engineer${merged.length === 1 ? "" : "s"} into current branch:`)
            for (const m of merged) {
              lines.push(`  ✓ ${m.engineerID} (task: "${m.taskTitle}")`)
            }
          }

          if (skipped.length > 0) {
            lines.push(`Skipped ${skipped.length}: ${skipped.map((s) => `${s.engineerID} (${s.reason})`).join(", ")}`)
          }

          if (conflicts.length > 0) {
            lines.push(`Conflicts ${conflicts.length}:`)
            for (const c of conflicts) {
              lines.push(`  ! ${c.engineerID} on branch ${c.branch}`)
              if (c.files.length > 0) {
                lines.push(`    Conflicting files: ${c.files.join(", ")}`)
              }
              lines.push(`    Resolve conflicts manually, then re-run team_commit.`)
            }
          } else {
            lines.push(`Conflicts 0`)
          }

          return {
            title: `Commit team ${params.teamID}`,
            output: lines.join("\n"),
            metadata: {
              teamID: params.teamID,
              merged: merged.map((m) => m.engineerID),
              conflicts: conflicts.map((c) => ({ engineerID: c.engineerID, branch: c.branch })),
              skipped: skipped.map((s) => s.engineerID),
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_report,
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

          const taskID = engineer.currentTask as import("../team/task-board.sql").TaskBoardID
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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

// ─── Team Inbox Tool (lightweight mailbox check) ────────────────────────────

export const TeamInboxTool = Tool.define(
  "team_inbox",
  Effect.gen(function* () {
    const mailbox = yield* Mailbox.Service

    return {
      description: TOOL_DESCRIPTIONS.team_inbox,
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
              metadata: { messageCount: 0, messages: [] as { id: string; priority: string; from: string }[] },
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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

// ─── Team Roster Tool (discover teammates) ─────────────────────────────────

export const TeamRosterTool = Tool.define(
  "team_roster",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service

    return {
      description: TOOL_DESCRIPTIONS.team_roster,
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
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_tasks,
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
          let tasks
          if (params.showAll) {
            tasks = allTasks
          } else {
            // Only show unblocked pending tasks (dependencies all completed)
            const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id))
            tasks = allTasks.filter(
              (t) =>
                t.status === "pending" &&
                !t.assigned_engineer_id &&
                t.dependencies.every((depId) => completedIds.has(depId)),
            )
          }

          if (tasks.length === 0) {
            const blockedPending = allTasks.filter(
              (t) => t.status === "pending" && !t.assigned_engineer_id,
            )
            const msg =
              params.showAll
                ? "No tasks in the team."
                : blockedPending.length > 0
                  ? `No claimable tasks right now — ${blockedPending.length} task(s) are waiting for dependencies. Use showAll=true to see all tasks.`
                  : "No unassigned tasks available. Use showAll=true to see all tasks."
            return {
              title: "Available tasks",
              output: msg,
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
        }).pipe(toolErrorBoundary, Effect.orDie),
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
      description: TOOL_DESCRIPTIONS.team_claim,
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

          // Check that all dependencies are completed
          if (task.dependencies.length > 0) {
            const allTasks = yield* taskBoard.list({ team_id: task.team_id })
            const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id))
            const unmet = task.dependencies.filter((depId) => !completedIds.has(depId))
            if (unmet.length > 0) {
              return yield* Effect.fail(
                new Error(
                  `Task "${task.title}" cannot be claimed yet. Blocked by unfinished dependencies: ${unmet.join(", ")}`,
                ),
              )
            }
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
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

// ─── Team Agents Tool ──────────────────────────────────────────────────────

// Module-level cache for the agents list. Intentionally mutable; invalidated only by process restart.
let _agentsCache: { value: Agent.Info[]; expiresAt: number } | null = null

const teamAgentsParams = z.object({
  includeNative: z.boolean().optional().describe(
    "Include native/built-in agents (default: false, only show user-configured agents)"
  ),
})

export const TeamAgentsTool = Tool.define(
  "team_agents",
  Effect.gen(function* () {
    const agentService = yield* Agent.Service

    return {
      description: TOOL_DESCRIPTIONS.team_agents,
      parameters: teamAgentsParams,
      execute: (params: z.infer<typeof teamAgentsParams>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const now = Date.now()
          const allAgents =
            _agentsCache && _agentsCache.expiresAt > now
              ? _agentsCache.value
              : yield* Effect.gen(function* () {
                  const fresh = yield* agentService.list()
                  _agentsCache = { value: fresh, expiresAt: now + TEAM_AGENTS_CACHE_TTL_MS }
                  return fresh
                })
          const defaultAgent = yield* agentService.defaultAgent()
          const includeNative = params.includeNative ?? false

          const agents = allAgents.filter((agent) => {
            if (agent.hidden) return false
            if (!includeNative && agent.native) return false
            return true
          })

          if (agents.length === 0) {
            return {
              title: "No configured agents",
              output: [
                "No user-configured agents found.",
                "",
                "Engineers will use the session's default model.",
                "",
                "To configure agents, add them to your opencode config:",
                "  ~/.config/opencode/config.json -> agents section",
                "",
                "Or use includeNative: true to see built-in agents.",
              ].join("\n"),
              metadata: { agentCount: 0, defaultAgent, agents: [] as string[] },
            }
          }

          const lines = [
            `Available agents for engineers:`,
            "",
            ...agents.map((agent) => {
              const modelInfo = agent.model
                ? `${agent.model.providerID}/${agent.model.modelID}`
                : "(session default)"
              const isDefault = agent.name === defaultAgent ? " [DEFAULT]" : ""
              return [
                `## ${agent.name}${isDefault}`,
                agent.description ? `   ${agent.description}` : "",
                `   Model: ${modelInfo}`,
                "",
              ].filter(Boolean).join("\n")
            }),
            "Usage in team_spawn:",
            '  agent: "agent-name"',
            "",
            "If no agent specified, engineers use the session's default model.",
          ]

          return {
            title: `Listed ${agents.length} agents`,
            output: lines.join("\n"),
            metadata: { agentCount: agents.length, defaultAgent, agents: agents.map((a) => a.name) },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

// ─── Team Share Tool (share all sessions for the team) ─────────────────────

export const TeamShareTool = Tool.define(
  "team_share",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator.Service
    const shareService = yield* SessionShare.Service

    return {
      description: TOOL_DESCRIPTIONS.team_share,
      parameters: z.object({
        teamID: z.string().describe("Team ID whose sessions to share"),
      }),
      execute: (params: { teamID: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* requireLead(ctx, coordinator, "share team transcripts")

          const teamID = params.teamID as ReturnType<typeof TeamID.ascending>
          const team = yield* coordinator.getTeam(teamID)
          if (!team) {
            return yield* Effect.fail(new Error(`Team ${params.teamID} not found`))
          }

          const engineers = yield* coordinator.listTeamEngineers(teamID)

          // Share lead session
          const leadResult = yield* shareService.share(team.leadSessionID)

          // Share each engineer session
          const engineerShares: { name: string; task: string | null; url: string }[] = []
          for (const eng of engineers) {
            const result = yield* shareService.share(eng.sessionID).pipe(
              Effect.catch((err: unknown) =>
                Effect.fail(new Error(`Failed to share engineer ${eng.name}: ${String(err)}`)),
              ),
            )
            engineerShares.push({ name: eng.name, task: eng.currentTask, url: result.url })
          }

          const lines: string[] = [
            `Team ${params.teamID} shared:`,
            `  Lead: ${leadResult.url}`,
            `  Engineers (${engineerShares.length}):`,
          ]
          for (const e of engineerShares) {
            const label = e.task ? `${e.name} (${e.task})` : e.name
            lines.push(`    ${label}: ${e.url}`)
          }

          return {
            title: `Share team ${params.teamID}`,
            output: lines.join("\n"),
            metadata: {
              teamID: params.teamID,
              leadURL: leadResult.url,
              engineers: engineerShares,
            },
          }
        }).pipe(toolErrorBoundary, Effect.orDie),
    }
  }),
)

// ─── Export all tools ───────────────────────────────────────────────────────

export const TeamTools = Effect.gen(function* () {
  const infos = (yield* Effect.all([
    TeamCreateTool,
    TeamSpawnTool,
    TeamDecomposeTool,
    TeamAssignTool,
    TeamReassignTool,
    TeamRetaskTool,
    TeamKillTool,
    TeamMonitorTool,
    TeamMessageTool,
    TeamStatusTool,
    TeamReportTool,
    TeamDissolveTool,
    TeamResumeTool,
    TeamCommitTool,
    TeamInboxTool,
    TeamRosterTool,
    TeamTasksTool,
    TeamClaimTool,
    TeamAgentsTool,
    TeamShareTool,
  ])) as Tool.Info[]
  return yield* Effect.all(infos.map(Tool.init))
})
