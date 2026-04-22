# Team Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create 10 LLM-callable team tools that bridge Effect services to fix the broken `/team-start` command.

**Architecture:** Tools in `src/tool/team.ts` wrap existing services (SessionCoordinator, LeadCoordinator, TaskBoard, Mailbox). Role-based access control via session lookup. Priority translation layer maps 4-tier to 3-tier mailbox.

**Tech Stack:** TypeScript, Effect, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-22-team-tools-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/tool/team.ts` | Create | 10 team tools |
| `src/tool/team.txt` | Create | Tool descriptions |
| `src/team/index.ts` | Create | Barrel exports |
| `src/tool/team.test.ts` | Create | Unit tests |
| `src/tool/registry.ts` | Modify | Register team tools |
| `src/team/session-coordinator.ts` | Modify | Add helper methods |
| `src/flag/flag.ts` | Modify | Add OPENCODE_TEAM_ENABLED |
| `src/command/template/team-start.txt` | Modify | Use tool names |

---

### Task 1: Add Feature Flag

**Files:**
- Modify: `packages/opencode/src/flag/flag.ts`

- [ ] **Step 1: Add OPENCODE_TEAM_ENABLED flag**

Open `packages/opencode/src/flag/flag.ts` and add:

```typescript
OPENCODE_TEAM_ENABLED: truthy("OPENCODE_TEAM_ENABLED"),
```

Add this line in the `Flag` object alongside other OPENCODE_* flags.

- [ ] **Step 2: Verify flag exists**

Run: `grep "OPENCODE_TEAM_ENABLED" packages/opencode/src/flag/flag.ts`
Expected: Shows the line you added

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/flag/flag.ts
git commit -m "feat(team): add OPENCODE_TEAM_ENABLED feature flag"
```

---

### Task 2: Create Team Barrel Export

**Files:**
- Create: `packages/opencode/src/team/index.ts`

- [ ] **Step 1: Create barrel export file**

Create `packages/opencode/src/team/index.ts`:

```typescript
export * from "./types"
export * from "./constants"
export * from "./session-coordinator"
export * from "./lead-coordinator"
export * from "./task-board"
export * from "./mailbox"
export * from "./auto-team"
export * from "./events"
```

- [ ] **Step 2: Verify exports compile**

Run: `cd packages/opencode && bun run tsc --noEmit src/team/index.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/team/index.ts
git commit -m "feat(team): add barrel export for team module"
```

---

### Task 3: Add SessionCoordinator Helper Methods

**Files:**
- Modify: `packages/opencode/src/team/session-coordinator.ts`

- [ ] **Step 1: Add interface methods**

In `packages/opencode/src/team/session-coordinator.ts`, add to the `Interface`:

```typescript
readonly isLead: (sessionID: SessionID) => Effect.Effect<boolean, CoordinatorError>
readonly isEngineer: (sessionID: SessionID) => Effect.Effect<boolean, CoordinatorError>
readonly getEngineerBySession: (sessionID: SessionID) => Effect.Effect<EngineerSlot | null, CoordinatorError>
readonly updateEngineer: (engineerID: EngineerID, updates: {
  state?: EngineerState
  currentTask?: string | null
  lastHeartbeat?: number
}) => Effect.Effect<EngineerSlot, CoordinatorError>
readonly getTeamForSession: (sessionID: SessionID) => Effect.Effect<TeamID | null, CoordinatorError>
```

- [ ] **Step 2: Import EngineerState type**

Ensure this import exists at the top:

```typescript
import { TeamID, EngineerID, type EngineerState } from "./types"
```

- [ ] **Step 3: Implement isLead**

Add inside the `layer` Effect.gen, after `hydrateFromDb`:

```typescript
const isLead = Effect.fn("SessionCoordinator.isLead")(function* (sessionID: SessionID) {
  for (const team of teams.values()) {
    if (team.leadSessionID === sessionID) return true
  }
  return false
})
```

- [ ] **Step 4: Implement isEngineer**

```typescript
const isEngineer = Effect.fn("SessionCoordinator.isEngineer")(function* (sessionID: SessionID) {
  for (const eng of engineers.values()) {
    if (eng.sessionID === sessionID) return true
  }
  return false
})
```

- [ ] **Step 5: Implement getEngineerBySession**

```typescript
const getEngineerBySession = Effect.fn("SessionCoordinator.getEngineerBySession")(function* (sessionID: SessionID) {
  for (const eng of engineers.values()) {
    if (eng.sessionID === sessionID) return eng
  }
  return null
})
```

- [ ] **Step 6: Implement getTeamForSession**

```typescript
const getTeamForSession = Effect.fn("SessionCoordinator.getTeamForSession")(function* (sessionID: SessionID) {
  // Check if lead
  for (const team of teams.values()) {
    if (team.leadSessionID === sessionID) return team.teamID
  }
  // Check if engineer
  for (const eng of engineers.values()) {
    if (eng.sessionID === sessionID) return eng.teamID
  }
  return null
})
```

- [ ] **Step 7: Implement updateEngineer**

```typescript
const updateEngineer = Effect.fn("SessionCoordinator.updateEngineer")(function* (
  engineerID: EngineerID,
  updates: { state?: EngineerState; currentTask?: string | null; lastHeartbeat?: number }
) {
  const eng = engineers.get(engineerID)
  if (!eng) {
    return yield* Effect.fail(new CoordinatorError({ message: `Engineer not found: ${engineerID}` }))
  }

  const now = Date.now()
  const updated: EngineerSlot = {
    ...eng,
    ...(updates.state !== undefined && { state: updates.state }),
    ...(updates.currentTask !== undefined && { currentTask: updates.currentTask }),
    ...(updates.lastHeartbeat !== undefined && { lastHeartbeat: updates.lastHeartbeat }),
  }

  yield* dbTx((db) => {
    db.update(EngineerSlotTable)
      .set({
        state: updated.state,
        current_task: updated.currentTask,
        last_heartbeat: updated.lastHeartbeat,
        time_updated: now,
      })
      .where(eq(EngineerSlotTable.id, engineerID))
      .run()
  })

  engineers.set(engineerID, updated)
  return updated
})
```

- [ ] **Step 8: Add methods to Service.of return**

Find the `return Service.of({` line and add the new methods:

```typescript
return Service.of({
  createTeam,
  spawnEngineer,
  resumeEngineer,
  killEngineer,
  dissolveTeam,
  getTeam,
  getEngineer,
  listTeamEngineers,
  listTeams,
  isLead,
  isEngineer,
  getEngineerBySession,
  updateEngineer,
  getTeamForSession,
})
```

- [ ] **Step 9: Verify compilation**

Run: `cd packages/opencode && bun run tsc --noEmit src/team/session-coordinator.ts`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/opencode/src/team/session-coordinator.ts
git commit -m "feat(team): add helper methods to SessionCoordinator"
```

---

### Task 4: Create Tool Description File

**Files:**
- Create: `packages/opencode/src/tool/team.txt`

- [ ] **Step 1: Create description file**

Create `packages/opencode/src/tool/team.txt`:

```
Team orchestration tools for multi-agent collaboration.

These tools enable a lead session to create and coordinate a team of engineer agents working on complex tasks.

Available tools:
- team_create: Initialize a new team for a goal
- team_spawn: Create an engineer and assign a task
- team_decompose: Break a goal into subtasks with file scopes
- team_assign: Auto-assign pending tasks to idle engineers
- team_reassign: Move a task from one engineer to another
- team_kill: Terminate a single engineer session
- team_monitor: Get progress report for a team
- team_message: Send a message to another session
- team_status: (Engineers only) Report state and progress
- team_dissolve: Gracefully shut down a team

Role restrictions:
- Lead-only: team_create, team_spawn, team_decompose, team_assign, team_reassign, team_kill, team_dissolve
- Engineer-only: team_status
- Both: team_monitor, team_message
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/tool/team.txt
git commit -m "feat(team): add team tools description"
```

---

### Task 5: Create Team Tools - Part 1 (team_create, team_monitor)

**Files:**
- Create: `packages/opencode/src/tool/team.ts`

- [ ] **Step 1: Create team.ts with imports and constants**

Create `packages/opencode/src/tool/team.ts`:

```typescript
import * as Tool from "./tool"
import { Effect } from "effect"
import z from "zod"
import { Service as SessionCoordinator, CoordinatorError } from "../team/session-coordinator"
import { Service as LeadCoordinator } from "../team/lead-coordinator"
import { Service as TaskBoardRepo } from "../team/task-board"
import { Service as Mailbox } from "../team/mailbox"
import { TeamID } from "../team/types"
import type { SessionID } from "../session/schema"
import DESCRIPTION from "./team.txt"

// Priority translation: 4-tier (tool) -> 3-tier (mailbox)
type ToolPriority = "low" | "normal" | "high" | "urgent"
type MailboxPriority = "urgent" | "inbox" | "queue"

function translatePriority(priority: ToolPriority): MailboxPriority {
  switch (priority) {
    case "urgent": return "urgent"
    case "high": return "inbox"
    case "normal": return "inbox"
    case "low": return "queue"
  }
}

// Role check helpers
function assertLead(ctx: Tool.Context, coordinator: SessionCoordinator.Interface) {
  return Effect.gen(function* () {
    const isLead = yield* coordinator.isLead(ctx.sessionID)
    if (!isLead) {
      return yield* Effect.fail(new Error("Only the team lead can use this tool"))
    }
  })
}

function assertEngineer(ctx: Tool.Context, coordinator: SessionCoordinator.Interface) {
  return Effect.gen(function* () {
    const isEng = yield* coordinator.isEngineer(ctx.sessionID)
    if (!isEng) {
      return yield* Effect.fail(new Error("Only engineers can use this tool"))
    }
  })
}
```

- [ ] **Step 2: Add team_create tool**

Append to `team.ts`:

```typescript
// ─── team_create ────────────────────────────────────────────────────────────

const teamCreateParams = z.object({
  goal: z.string().describe("The high-level goal for this team"),
})

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator

    return {
      description: "Initialize a new team. Only callable by a session that will become the lead.",
      parameters: teamCreateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const teamID = TeamID.ascending()
          const leadSessionID = ctx.sessionID

          const team = yield* coordinator.createTeam({
            teamID,
            leadSessionID,
            goal: params.goal,
          }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          return {
            title: "Team created",
            metadata: { teamID: team.teamID },
            output: [
              `Team created successfully.`,
              ``,
              `teamID: ${team.teamID}`,
              `leadSessionID: ${team.leadSessionID}`,
              `goal: ${params.goal}`,
              ``,
              `Next: Use team_spawn to create engineers, or team_decompose to break down the goal.`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 3: Add team_monitor tool**

Append to `team.ts`:

```typescript
// ─── team_monitor ───────────────────────────────────────────────────────────

const teamMonitorParams = z.object({
  teamID: z.string().describe("Team ID to monitor"),
})

export const TeamMonitorTool = Tool.define(
  "team_monitor",
  Effect.gen(function* () {
    const lead = yield* LeadCoordinator

    return {
      description: "Get progress report for a team. Available to both lead and engineers.",
      parameters: teamMonitorParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const teamID = params.teamID as TeamID
          const report = yield* lead.monitor(teamID).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          const output = lead.formatStatus(report)

          return {
            title: "Team status",
            metadata: {
              totalTasks: report.totalTasks,
              pending: report.pending,
              inProgress: report.inProgress,
              completed: report.completed,
              failed: report.failed,
              blocked: report.blocked,
            },
            output,
          }
        }),
    }
  }),
)
```

- [ ] **Step 4: Verify compilation**

Run: `cd packages/opencode && bun run tsc --noEmit src/tool/team.ts`
Expected: No errors (or import errors we'll fix)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/tool/team.ts
git commit -m "feat(team): add team_create and team_monitor tools"
```

---

### Task 6: Create Team Tools - Part 2 (team_spawn, team_assign)

**Files:**
- Modify: `packages/opencode/src/tool/team.ts`

- [ ] **Step 1: Add team_spawn tool**

Append to `team.ts`:

```typescript
// ─── team_spawn ─────────────────────────────────────────────────────────────

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
    const coordinator = yield* SessionCoordinator
    const taskBoard = yield* TaskBoardRepo

    return {
      description: "Create an engineer session and assign a task. Lead only.",
      parameters: teamSpawnParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const teamID = params.teamID as TeamID

          // Spawn engineer
          const engineer = yield* coordinator.spawnEngineer({
            teamID,
            leadSessionID: ctx.sessionID,
            name: params.name,
          }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          // Create task
          const task = yield* taskBoard.create({
            team_id: teamID,
            title: params.task.title,
            description: params.task.description,
            file_scope: params.task.fileScope ? JSON.stringify(params.task.fileScope) : null,
            status: "in-progress",
            assigned_engineer_id: engineer.engineerID,
          }).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          // Update engineer's current task
          yield* coordinator.updateEngineer(engineer.engineerID, {
            state: "working",
            currentTask: task.id,
          }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          return {
            title: `Spawned ${params.name}`,
            metadata: {
              engineerID: engineer.engineerID,
              sessionID: engineer.sessionID,
              taskID: task.id,
            },
            output: [
              `Engineer spawned and task assigned.`,
              ``,
              `engineerID: ${engineer.engineerID}`,
              `sessionID: ${engineer.sessionID}`,
              `name: ${params.name}`,
              `taskID: ${task.id}`,
              `task: ${params.task.title}`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 2: Add team_assign tool**

Append to `team.ts`:

```typescript
// ─── team_assign ────────────────────────────────────────────────────────────

const teamAssignParams = z.object({
  teamID: z.string().describe("Team ID"),
})

export const TeamAssignTool = Tool.define(
  "team_assign",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const lead = yield* LeadCoordinator

    return {
      description: "Auto-assign pending tasks to idle engineers. Lead only.",
      parameters: teamAssignParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const teamID = params.teamID as TeamID

          // Get engineers for this team
          const engineerSlots = yield* coordinator.listTeamEngineers(teamID).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          // Convert to EngineerStateRecord format expected by LeadCoordinator
          const engineers = engineerSlots.map((slot) => ({
            engineerID: slot.engineerID,
            state: slot.state,
            currentTask: slot.currentTask,
          }))

          const assigned = yield* lead.assign({
            teamId: teamID,
            engineers,
          }).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          // Update assigned engineers' state
          for (const task of assigned) {
            if (task.assigned_engineer_id) {
              yield* coordinator.updateEngineer(task.assigned_engineer_id, {
                state: "working",
                currentTask: task.id,
              }).pipe(Effect.catchAll(() => Effect.void))
            }
          }

          const report = yield* lead.monitor(teamID).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          return {
            title: `Assigned ${assigned.length} tasks`,
            metadata: {
              assigned: assigned.length,
              pending: report.pending,
            },
            output: [
              `Assigned ${assigned.length} tasks to idle engineers.`,
              ``,
              `Assignments:`,
              ...assigned.map((t) => `  - ${t.title} → ${t.assigned_engineer_id}`),
              ``,
              `Remaining pending: ${report.pending}`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/tool/team.ts
git commit -m "feat(team): add team_spawn and team_assign tools"
```

---

### Task 7: Create Team Tools - Part 3 (team_decompose, team_reassign, team_kill)

**Files:**
- Modify: `packages/opencode/src/tool/team.ts`

- [ ] **Step 1: Add team_decompose tool**

Append to `team.ts`:

```typescript
// ─── team_decompose ─────────────────────────────────────────────────────────

const teamDecomposeParams = z.object({
  teamID: z.string().describe("Team ID"),
  subtasks: z.array(z.object({
    title: z.string(),
    description: z.string(),
    files: z.array(z.string()).default([]),
  })).describe("Subtasks to create (pre-parsed by LLM)"),
})

export const TeamDecomposeTool = Tool.define(
  "team_decompose",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const lead = yield* LeadCoordinator

    return {
      description: "Create subtasks with file scopes. Lead only. Pass pre-structured subtasks.",
      parameters: teamDecomposeParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const teamID = params.teamID as TeamID

          const tasks = yield* lead.decompose({
            teamId: teamID,
            subtasks: params.subtasks,
            request: `Decomposed into ${params.subtasks.length} subtasks`,
          }).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          return {
            title: `Created ${tasks.length} subtasks`,
            metadata: { taskCount: tasks.length },
            output: [
              `Created ${tasks.length} subtasks:`,
              ``,
              ...tasks.map((t, i) => `${i + 1}. ${t.title} (${t.file_scope ? "scoped" : "no scope"})`),
              ``,
              `Use team_spawn or team_assign to assign engineers.`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 2: Add team_reassign tool**

Append to `team.ts`:

```typescript
// ─── team_reassign ──────────────────────────────────────────────────────────

const teamReassignParams = z.object({
  taskID: z.string().describe("Task ID to reassign"),
  toEngineerID: z.string().describe("Target engineer ID"),
})

export const TeamReassignTool = Tool.define(
  "team_reassign",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const lead = yield* LeadCoordinator

    return {
      description: "Move a task from one engineer to another. Lead only.",
      parameters: teamReassignParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const task = yield* lead.reassign({
            taskId: params.taskID as any,
            toEngineer: params.toEngineerID as any,
          }).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          // Update new engineer's state
          yield* coordinator.updateEngineer(params.toEngineerID as any, {
            state: "working",
            currentTask: task.id,
          }).pipe(Effect.catchAll(() => Effect.void))

          return {
            title: "Task reassigned",
            metadata: { taskID: task.id, toEngineer: params.toEngineerID },
            output: [
              `Task reassigned successfully.`,
              ``,
              `taskID: ${task.id}`,
              `title: ${task.title}`,
              `assigned to: ${params.toEngineerID}`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 3: Add team_kill tool**

Append to `team.ts`:

```typescript
// ─── team_kill ──────────────────────────────────────────────────────────────

const teamKillParams = z.object({
  engineerID: z.string().describe("Engineer ID to terminate"),
})

export const TeamKillTool = Tool.define(
  "team_kill",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const taskBoard = yield* TaskBoardRepo

    return {
      description: "Terminate a single engineer session. Lead only.",
      parameters: teamKillParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const engineerID = params.engineerID as any

          // Get engineer to find teamID
          const engineer = yield* coordinator.getEngineer(engineerID).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          if (!engineer) {
            return yield* Effect.fail(new Error(`Engineer not found: ${engineerID}`))
          }

          // Find tasks assigned to this engineer and mark as pending
          const tasks = yield* taskBoard.list({
            team_id: engineer.teamID,
            assigned_engineer_id: engineerID,
          }).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          let tasksReassigned = 0
          for (const task of tasks) {
            if (task.status === "in-progress") {
              yield* taskBoard.update(task.id, {
                status: "pending",
                assigned_engineer_id: null,
              }).pipe(Effect.catchAll(() => Effect.void))
              tasksReassigned++
            }
          }

          // Kill the engineer
          yield* coordinator.killEngineer({
            engineerID,
            teamID: engineer.teamID,
          }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          return {
            title: "Engineer terminated",
            metadata: { engineerID, tasksReassigned },
            output: [
              `Engineer terminated.`,
              ``,
              `engineerID: ${engineerID}`,
              `tasksReassigned: ${tasksReassigned}`,
              ``,
              tasksReassigned > 0
                ? `Use team_assign to reassign orphaned tasks.`
                : `No tasks needed reassignment.`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/tool/team.ts
git commit -m "feat(team): add team_decompose, team_reassign, team_kill tools"
```

---

### Task 8: Create Team Tools - Part 4 (team_message, team_status, team_dissolve)

**Files:**
- Modify: `packages/opencode/src/tool/team.ts`

- [ ] **Step 1: Add team_message tool**

Append to `team.ts`:

```typescript
// ─── team_message ───────────────────────────────────────────────────────────

const teamMessageParams = z.object({
  recipientID: z.string().describe("Engineer ID, or 'lead' to message the lead"),
  content: z.string().describe("Message content"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
})

export const TeamMessageTool = Tool.define(
  "team_message",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const mailbox = yield* Mailbox

    return {
      description: "Send a message to another session. Available to lead and engineers.",
      parameters: teamMessageParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const senderSessionID = ctx.sessionID

          // Get sender's team
          const senderTeamID = yield* coordinator.getTeamForSession(senderSessionID).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          if (!senderTeamID) {
            return yield* Effect.fail(new Error("You are not part of a team"))
          }

          // Resolve recipient session ID
          let recipientSessionID: SessionID

          if (params.recipientID === "lead") {
            const team = yield* coordinator.getTeam(senderTeamID).pipe(
              Effect.catchTag("CoordinatorError", (e) =>
                Effect.fail(new Error(e.message))
              )
            )
            if (!team) {
              return yield* Effect.fail(new Error("Team not found"))
            }
            recipientSessionID = team.leadSessionID
          } else {
            const engineer = yield* coordinator.getEngineer(params.recipientID as any).pipe(
              Effect.catchTag("CoordinatorError", (e) =>
                Effect.fail(new Error(e.message))
              )
            )
            if (!engineer) {
              return yield* Effect.fail(new Error(`Engineer not found: ${params.recipientID}`))
            }
            if (engineer.teamID !== senderTeamID) {
              return yield* Effect.fail(new Error("Cannot message engineer on different team"))
            }
            recipientSessionID = engineer.sessionID
          }

          const mailboxPriority = translatePriority(params.priority)

          const msg = yield* mailbox.send({
            recipientSessionID,
            senderSessionID,
            priority: mailboxPriority,
            type: "team_message",
            content: params.content,
          })

          return {
            title: "Message sent",
            metadata: { messageID: msg.id, delivered: true },
            output: [
              `Message sent.`,
              ``,
              `to: ${params.recipientID}`,
              `priority: ${params.priority}`,
              `messageID: ${msg.id}`,
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 2: Add team_status tool**

Append to `team.ts`:

```typescript
// ─── team_status ────────────────────────────────────────────────────────────

const teamStatusParams = z.object({
  state: z.enum(["working", "blocked", "completed"]).describe("Current state"),
  progress: z.string().optional().describe("Progress description"),
  blocker: z.string().optional().describe("Blocker description if blocked"),
})

export const TeamStatusTool = Tool.define(
  "team_status",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const taskBoard = yield* TaskBoardRepo

    return {
      description: "Report state and progress. Engineer only.",
      parameters: teamStatusParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertEngineer(ctx, coordinator)

          const engineer = yield* coordinator.getEngineerBySession(ctx.sessionID).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          if (!engineer) {
            return yield* Effect.fail(new Error("Engineer not found for this session"))
          }

          // Map state to EngineerState
          const engineerState = params.state === "completed" ? "idle" as const
            : params.state === "blocked" ? "blocked" as const
            : "working" as const

          // Update engineer state
          yield* coordinator.updateEngineer(engineer.engineerID, {
            state: engineerState,
            lastHeartbeat: Date.now(),
          }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          // Update task if engineer has one
          if (engineer.currentTask) {
            const taskStatus = params.state === "completed" ? "completed" as const
              : params.state === "blocked" ? "blocked" as const
              : "in-progress" as const

            yield* taskBoard.update(engineer.currentTask as any, {
              status: taskStatus,
              ...(params.state === "completed" && { completed_at: Date.now() }),
            }).pipe(Effect.catchAll(() => Effect.void))

            // Clear current task if completed
            if (params.state === "completed") {
              yield* coordinator.updateEngineer(engineer.engineerID, {
                currentTask: null,
              }).pipe(Effect.catchAll(() => Effect.void))
            }
          }

          return {
            title: `Status: ${params.state}`,
            metadata: { state: params.state, updated: true },
            output: [
              `Status updated.`,
              ``,
              `state: ${params.state}`,
              ...(params.progress ? [`progress: ${params.progress}`] : []),
              ...(params.blocker ? [`blocker: ${params.blocker}`] : []),
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 3: Add team_dissolve tool**

Append to `team.ts`:

```typescript
// ─── team_dissolve ──────────────────────────────────────────────────────────

const teamDissolveParams = z.object({
  teamID: z.string().describe("Team ID to dissolve"),
  force: z.boolean().default(false).describe("Force dissolve even with in-progress tasks"),
})

export const TeamDissolveTool = Tool.define(
  "team_dissolve",
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinator
    const taskBoard = yield* TaskBoardRepo
    const lead = yield* LeadCoordinator

    return {
      description: "Gracefully shut down a team. Lead only.",
      parameters: teamDissolveParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertLead(ctx, coordinator)

          const teamID = params.teamID as TeamID

          // Check for in-progress tasks
          const report = yield* lead.monitor(teamID).pipe(
            Effect.catchAll((e) => Effect.fail(new Error(String(e))))
          )

          if (report.inProgress > 0 && !params.force) {
            return yield* Effect.fail(
              new Error(`Cannot dissolve: ${report.inProgress} tasks in progress. Use force=true to terminate immediately.`)
            )
          }

          // Get engineers count before dissolving
          const engineers = yield* coordinator.listTeamEngineers(teamID).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          const engineerCount = engineers.length

          // Mark in-progress tasks as failed if force
          if (params.force) {
            const tasks = yield* taskBoard.list({ team_id: teamID }).pipe(
              Effect.catchAll((e) => Effect.fail(new Error(String(e))))
            )
            for (const task of tasks) {
              if (task.status === "in-progress") {
                yield* taskBoard.update(task.id, { status: "failed" }).pipe(
                  Effect.catchAll(() => Effect.void)
                )
              }
            }
          }

          // Dissolve the team
          yield* coordinator.dissolveTeam({ teamID }).pipe(
            Effect.catchTag("CoordinatorError", (e) =>
              Effect.fail(new Error(e.message))
            )
          )

          return {
            title: "Team dissolved",
            metadata: { dissolved: true, engineersTerminated: engineerCount },
            output: [
              `Team dissolved.`,
              ``,
              `teamID: ${teamID}`,
              `engineersTerminated: ${engineerCount}`,
              ...(params.force ? [`(forced - in-progress tasks marked as failed)`] : []),
            ].join("\n"),
          }
        }),
    }
  }),
)
```

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/tool/team.ts
git commit -m "feat(team): add team_message, team_status, team_dissolve tools"
```

---

### Task 9: Export Team Tools

**Files:**
- Modify: `packages/opencode/src/tool/team.ts`

- [ ] **Step 1: Add TeamTools export**

Append to the end of `team.ts`:

```typescript
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
```

- [ ] **Step 2: Verify compilation**

Run: `cd packages/opencode && bun run tsc --noEmit src/tool/team.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/tool/team.ts
git commit -m "feat(team): export TeamTools array"
```

---

### Task 10: Register Team Tools in Registry

**Files:**
- Modify: `packages/opencode/src/tool/registry.ts`

- [ ] **Step 1: Import TeamTools**

Add import at top of `registry.ts`:

```typescript
import { TeamTools } from "./team"
```

- [ ] **Step 2: Import Flag**

Ensure Flag is imported:

```typescript
import { Flag } from "@/flag/flag"
```

- [ ] **Step 3: Add team tools to builtin array**

In the `state` initialization, after the `tool` Effect.all block, add team tools conditionally:

Find the line:
```typescript
return {
  custom,
  builtin: [
```

And modify the builtin array to include team tools:

```typescript
// After the existing builtin tools array creation
const teamTools = Flag.OPENCODE_TEAM_ENABLED
  ? yield* TeamTools.pipe(Effect.catchAll(() => Effect.succeed([])))
  : []

return {
  custom,
  builtin: [
    tool.invalid,
    ...(questionEnabled ? [tool.question] : []),
    tool.bash,
    tool.read,
    tool.glob,
    tool.grep,
    tool.edit,
    tool.write,
    tool.task,
    tool.fetch,
    tool.todo,
    tool.search,
    tool.code,
    tool.skill,
    tool.patch,
    ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
    ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
    ...teamTools,
  ],
  task: tool.task,
  read: tool.read,
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd packages/opencode && bun run tsc --noEmit src/tool/registry.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/tool/registry.ts
git commit -m "feat(team): register team tools in registry"
```

---

### Task 11: Update team-start.txt Prompt

**Files:**
- Modify: `packages/opencode/src/command/template/team-start.txt`

- [ ] **Step 1: Update prompt to use tool names**

Replace the entire content of `team-start.txt`:

```
# Team Start

You are the **Lead Engineer**. A new team is being formed to accomplish the following goal:

**Goal:** $ARGUMENTS

## Step 1: Create Team

Use the `team_create` tool to initialize the team:
- Pass the goal as the `goal` parameter
- This returns a `teamID` you'll use in subsequent calls

## Step 2: Decompose the Request

Break the goal into independent subtasks. For each subtask, identify:
- A clear title
- A detailed description
- The files that will be modified (file scope)

Use the `team_decompose` tool with your structured subtasks.
Ensure subtasks have non-overlapping file scopes to prevent conflicts.

## Step 3: Spawn Engineers

For each subtask, use the `team_spawn` tool to create an engineer:
- Provide the `teamID` from step 1
- Give each engineer a descriptive name (e.g., "engineer-auth", "engineer-api")
- Include the task details (title, description, fileScope)

Each spawned engineer will start working autonomously on their task.

## Step 4: Monitor Progress

Use `team_monitor` to track progress:
- Call it periodically to see status
- Watch for blocked or failed engineers
- Use `team_reassign` if needed to move tasks

## Step 5: Handle Issues

- If an engineer is blocked: Check the blocker, provide help via `team_message`
- If an engineer fails: Use `team_kill` to terminate, then `team_spawn` a replacement
- Use `team_message` to coordinate between engineers when needed

## Step 6: Complete

When all tasks are done:
- Review the work
- Use `team_dissolve` to shut down the team

## Available Tools

Lead-only: `team_create`, `team_spawn`, `team_decompose`, `team_assign`, `team_reassign`, `team_kill`, `team_dissolve`
Both: `team_monitor`, `team_message`

## Output Format

After team startup, display:

```
Team started: <teamID>
Engineers spawned: <count>
Tasks assigned: <count> / <total>

Engineers:
  <name> — <task title> [working]
  ...

Pending tasks:
  <task title> (unassigned)
```
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/command/template/team-start.txt
git commit -m "docs(team): update team-start prompt to use tool names"
```

---

### Task 12: Build and Test

**Files:**
- All modified files

- [ ] **Step 1: Run type check**

Run: `cd packages/opencode && bun run tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Build the package**

Run: `cd packages/opencode && bun run build`
Expected: Build completes successfully

- [ ] **Step 3: Install new binary**

Run: `cp packages/opencode/dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode`

- [ ] **Step 4: Test team tools appear**

Run: `OPENCODE_TEAM_ENABLED=true opencode --help`
Expected: OpenCode starts without errors

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(team): complete team tools implementation

- 10 LLM-callable team tools
- SessionCoordinator helper methods
- Feature flag OPENCODE_TEAM_ENABLED
- Updated team-start prompt
- Tool descriptions and registry integration"
```

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Add feature flag | 2 min |
| 2 | Create barrel export | 2 min |
| 3 | Add SessionCoordinator helpers | 10 min |
| 4 | Create tool description | 2 min |
| 5 | team_create, team_monitor | 5 min |
| 6 | team_spawn, team_assign | 5 min |
| 7 | team_decompose, team_reassign, team_kill | 8 min |
| 8 | team_message, team_status, team_dissolve | 8 min |
| 9 | Export TeamTools | 3 min |
| 10 | Register in registry | 5 min |
| 11 | Update team-start prompt | 3 min |
| 12 | Build and test | 5 min |

**Total:** ~58 minutes
