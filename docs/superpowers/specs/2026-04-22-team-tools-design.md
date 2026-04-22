# Team Tools Design Spec

**Date:** 2026-04-22  
**Status:** Approved  
**Author:** Alan (ProDrifterDK) + Claude

## Problem Statement

The `/team-start` command and auto-team feature are broken. The prompts tell the LLM to call Effect services (`SessionCoordinator.spawnEngineer`, `LeadCoordinator.assign`) directly, but LLMs can only call tools. No team tools exist in the tool registry.

## Solution

Create 8 team tools that bridge the Effect services to LLM-callable tools, enabling functional multi-agent team orchestration.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool structure | Separate tools (not unified) | Matches existing patterns (bash, read, write) |
| Tool count | 8 tools (full set) | Complete coverage of team functionality |
| Engineer execution | Autonomous sessions | True parallel agents that can communicate |
| Message delivery | Priority-based injection | Urgent interrupts, normal injects next turn, low batched |
| Failure handling | 2 retries + escalate | Balance autonomy with oversight |
| Tool access | Lead-only for most | Prevents runaway team creation |
| Implementation | Single `team.ts` file | Pragmatic for 8 related tools |

## Tool Definitions

### Tool Access Matrix

| Tool | Lead | Engineer | Purpose |
|------|------|----------|---------|
| `team_create` | ✅ | ❌ | Initialize a new team |
| `team_spawn` | ✅ | ❌ | Create engineer session, start with task |
| `team_decompose` | ✅ | ❌ | Break goal into subtasks with file scopes |
| `team_assign` | ✅ | ❌ | Auto-assign pending tasks to idle engineers |
| `team_monitor` | ✅ | ✅ | Get progress report |
| `team_message` | ✅ | ✅ | Send message to another session |
| `team_status` | ❌ | ✅ | Report state and progress |
| `team_dissolve` | ✅ | ❌ | Gracefully shut down team |

### Tool Schemas

#### `team_create`
```typescript
{
  goal: z.string().describe("The high-level goal for this team")
}
// Returns: { teamID, leadSessionID }
```

#### `team_spawn`
```typescript
{
  teamID: z.string().describe("Team ID from team_create"),
  name: z.string().describe("Engineer name (e.g., 'engineer-auth')"),
  task: z.object({
    title: z.string(),
    description: z.string(),
    fileScope: z.array(z.string()).optional()
  })
}
// Returns: { engineerID, sessionID, task }
```

#### `team_decompose`
```typescript
{
  teamID: z.string(),
  goal: z.string().describe("Goal to break into subtasks"),
  maxTasks: z.number().optional().default(5)
}
// Returns: Task[] with titles, descriptions, fileScopes
```

#### `team_assign`
```typescript
{
  teamID: z.string()
}
// Returns: { assigned: Task[], pending: Task[], engineers: EngineerSummary[] }
```

#### `team_monitor`
```typescript
{
  teamID: z.string()
}
// Returns: ProgressReport { total, pending, inProgress, completed, failed, blocked, engineers[], blockers[] }
```

#### `team_message`
```typescript
{
  recipientID: z.string().describe("Engineer ID or 'lead'"),
  content: z.string(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal")
}
// Returns: { messageID, delivered: boolean }
```

#### `team_status`
```typescript
{
  state: z.enum(["working", "blocked", "completed"]),
  progress: z.string().optional(),
  blocker: z.string().optional()
}
// Returns: { updated: true, state }
```

#### `team_dissolve`
```typescript
{
  teamID: z.string(),
  force: z.boolean().optional().default(false)
}
// Returns: { dissolved: true, engineersTerminated: number }
```

## Engineer Lifecycle

### Spawn Flow
```
team_spawn(teamID, name, task)
    │
    ├─► SessionCoordinator.spawnEngineer()
    │       └─► Creates EngineerSlot (state: "idle")
    │       └─► Creates child Session
    │
    ├─► TaskBoard.create(task)
    │       └─► Task status: "in-progress"
    │       └─► assigned_engineer_id set
    │
    └─► Start prompt loop for engineer session
            └─► Engineer receives: task description + file scope
            └─► Engineer has access to: team_status, team_message, team_monitor
            └─► Engineer works autonomously
```

### Engineer Execution
1. Engineer receives task prompt with file scope constraints
2. Engineer works using standard tools (read, edit, bash, etc.)
3. Engineer calls `team_status({ state: "working", progress: "..." })` periodically
4. If blocked: `team_status({ state: "blocked", blocker: "..." })` triggers escalation after 2 retries
5. On completion: `team_status({ state: "completed" })` updates TaskBoard, engineer goes idle

### Failure Handling (2 retries + escalate)
```
Engineer hits error
    │
    ├─► Retry 1 (with error context)
    │       └─► Success? → Continue
    │
    ├─► Retry 2 (with accumulated context)
    │       └─► Success? → Continue
    │
    └─► Escalate to Lead
            └─► team_message(lead, "Failed after 2 retries: {context}", "urgent")
            └─► team_status({ state: "failed" })
            └─► Lead decides: reassign, modify task, or abort
```

## Message System

### Priority-Based Message Injection

| Priority | Behavior | Use Case |
|----------|----------|----------|
| `urgent` | Interrupts current turn, injected immediately | Failures, blockers, critical updates |
| `high` | Injected at start of next turn | Task reassignments, important coordination |
| `normal` | Injected at start of next turn | Progress updates, questions |
| `low` | Batched and summarized every 5 turns | FYI messages, logs |

### Message Flow
```
Engineer A                          Engineer B
    │                                   │
    └─► team_message(B, "need auth token", "high")
            │
            └─► Mailbox.send()
                    │
                    └─► Bus.publish(Event.Received)
                            │
                            └─► Prompt loop checks mailbox before next turn
                                    │
                                    └─► Injects: <team_message from="A" priority="high">
                                                   need auth token
                                                 </team_message>
```

### Low Priority Batching
Messages with `priority: "low"` accumulate and are summarized every 5 turns using `MessageSummarizer` service.

## File Changes

### New Files
```
src/tool/team.ts                    — 8 team tools
src/tool/team.txt                   — Tool descriptions
src/team/index.ts                   — Barrel export (missing today)
```

### Modified Files
```
src/tool/registry.ts                — Register team tools
src/command/template/team-start.txt — Update to use tool names
src/team/auto-team.ts               — Fix buildPrompt to reference tools
src/team/session-coordinator.ts     — Add role check helpers (isLead, isEngineer)
```

### Tool Registration
```typescript
// In registry.ts
import { TeamTools } from "./team"

// In builtin array:
...(Flag.OPENCODE_TEAM_ENABLED ? yield* TeamTools : []),
```

### Role Detection
Add to `SessionCoordinator`:
```typescript
isLead(sessionID: SessionID): boolean
isEngineer(sessionID: SessionID): boolean
```

Tools check role before executing.

## Constants

```typescript
ENGINEER_MAX_RETRIES = 2        // Retries before escalating to lead
LOW_PRIORITY_BATCH_INTERVAL = 5 // Turns between low-priority message summaries
```

## Feature Flag

Enable with `OPENCODE_TEAM_ENABLED=true` or via config. Tools are only registered when flag is enabled.

## Testing Strategy

1. **Unit tests** for each tool in `src/tool/team.test.ts`
2. **Integration tests** for engineer lifecycle in `src/team/team-tools-integration.test.ts`
3. **E2E test** running `/team-start` with a simple goal

## Success Criteria

1. `/team-start` creates a functional team with engineers in TUI sidebar
2. Engineers appear in `team_state` and `engineer_slot` database tables
3. Tasks appear in `task_board` table
4. Messages flow between agents via `mailbox` table
5. `team_monitor` shows accurate progress
6. Engineers complete tasks autonomously
7. Failures escalate to lead after 2 retries
