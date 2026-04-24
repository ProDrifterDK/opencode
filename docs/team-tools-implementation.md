# OpenCode Team Tools Implementation

## Overview

Team Tools enable multi-agent collaboration in OpenCode. Unlike subagents (which work in isolation and return results), Team architecture allows:
- **Shared Task List** - teammates claim tasks from a shared pool
- **Peer Communication** - teammates communicate with each other via mailbox
- **Event-driven Coordination** - daemon manages engineer lifecycles

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Agent (Team Lead)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ Spawn Team & Assign Tasks
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Shared Task List                         │
│                    (TaskBoardRepo)                          │
└───────┬─────────────────┬─────────────────┬─────────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │Teammate │◄─────►│Teammate │◄─────►│Teammate │
   │(Engineer)│      │(Engineer)│      │(Engineer)│
   └────┬────┘       └────┬────┘       └────┬────┘
        │                 │                 │
        └────────Work─────┴────────Work─────┘
```

## Feature Flag

```bash
OPENCODE_TEAM_ENABLED=true opencode
```

## Key Files

### Core Services (`src/team/`)

| File | Purpose |
|------|---------|
| `session-coordinator.ts` | Manages team lifecycle, engineer slots, team state |
| `lead-coordinator.ts` | Lead-specific operations: decompose, assign, reassign, monitor |
| `task-board.ts` | Shared task list CRUD operations |
| `mailbox.ts` | Inter-agent messaging (3 priorities: urgent, inbox, queue) |
| `daemon.ts` | **NEW** - Event-driven daemon that starts engineer loops |
| `events.ts` | Bus event definitions for team coordination |
| `types.ts` | TypeScript types: TeamID, EngineerID, EngineerSlot, etc. |

### LLM-Callable Tools (`src/tool/`)

| File | Tools |
|------|-------|
| `team.ts` | 12 tools: team_create, team_spawn, team_decompose, team_assign, team_reassign, team_kill, team_monitor, team_inbox, team_message, team_status, team_report, team_dissolve |
| `team.txt` | Tool descriptions for LLM context |

### Runtime Integration (`src/effect/`)

| File | Purpose |
|------|---------|
| `app-runtime.ts` | AppLayer composition - includes all team services and daemon |

### Registry (`src/tool/`)

| File | Purpose |
|------|---------|
| `registry.ts` | Tool registry - conditionally loads TeamTools when flag enabled |

## Architecture Patterns

### Effect-ts Layer System

All services use Effect-ts layers for dependency injection:

```typescript
// Service definition
export class Service extends Context.Service<Service, Interface>()("@opencode/ServiceName") {}

// Layer definition
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const dep = yield* DependencyService
  // ... implementation
  return Service.of({ method1, method2 })
}))

// Default layer with dependencies
export const defaultLayer = layer.pipe(
  Layer.provide(Dependency1.defaultLayer),
  Layer.provide(Dependency2.layer),
)
```

### Tool Definition Pattern

```typescript
export const MyTool = Tool.define(
  "tool_name",
  Effect.gen(function* () {
    const service = yield* SomeService.Service
    
    return {
      description: DESCRIPTION,
      parameters: z.object({ /* zod schema */ }),
      execute: (params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Implementation
          return {
            title: "...",
            output: "...",
            metadata: { /* ... */ },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
```

### Event-Driven Pattern

Events defined in `events.ts`:
```typescript
export const Event = {
  EngineerSpawned: BusEvent.define("engineer.spawned", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    sessionID: z.string(),
    name: z.string(),
    taskID: z.string(),
    taskTitle: z.string(),
    taskDescription: z.string(),
  })),
  EngineerProgress: BusEvent.define("engineer.progress", z.object({
    teamID: z.string(),
    engineerID: z.string(),
    progressText: z.string(),  // Displayed in sidebar
    timestamp: z.number(),
  })),
  // ... other events (EngineerCompleted, EngineerFailed, TaskUpdated, etc.)
}
```

Publishing events:
```typescript
import { Event, publishTeamEvent } from "../team/events"

publishTeamEvent(Event.EngineerSpawned, {
  teamID, engineerID, sessionID, name, taskID, taskTitle, taskDescription
})
```

Subscribing (in daemon):
```typescript
const unsubscribe = yield* bus.subscribeCallback(Event.EngineerSpawned, handleEngineerSpawned)
```

## Team Daemon Flow

```
1. team_spawn tool called by lead
   │
   ├── Creates engineer session (session.create)
   ├── Creates task in TaskBoard
   ├── Updates engineer state to "working" (coordinator.updateEngineer)
   └── Publishes EngineerSpawned event
          │
          ▼
2. TeamDaemon receives event (via bus.subscribeCallback)
   │
   └── Calls startEngineerInBackground()
          │
          └── AppRuntime.runFork(createEngineerLoopEffect)
                 │
                 ▼
3. Engineer session starts processing
   │
   ├── SessionPrompt.prompt() sends initial task instructions
   ├── SessionPrompt.loop() runs the agent loop
   ├── Can use tools (Read, Write, Edit, Bash, etc.)
   ├── Checks mailbox for messages periodically
   └── Calls team_report when complete
          │
          ▼
4. team_report sends notification to lead
   │
   ├── Updates task status in TaskBoard
   ├── Updates engineer state to "completed"/"blocked"/"failed"
   ├── Publishes EngineerCompleted event (for UI)
   └── Sends mailbox message to lead (publishes LeadMessageReceived event)
          │
          ▼
5. TeamDaemon receives LeadMessageReceived event
   │
   ├── handleLeadMessageReceived() triggered by bus.subscribeCallback
   ├── Verifies session is a lead (coordinator.isLead)
   ├── Fetches message from mailbox (mailbox.receiveByPriority)
   ├── Marks message as read
   └── Injects notification via SessionPrompt.prompt() with "[MESSAGE FROM ENGINEER]"
          │
          ▼
6. Lead's session receives injected prompt
   │
   ├── Lead's loop wakes up to process the notification
   └── Lead sees engineer's report and can respond/take action
```

### Daemon Implementation Details

The daemon uses `AppRuntime.runFork` (not `Effect.fork`) to start engineer loops. This is critical because:

1. **Service Resolution**: `AppRuntime` has all services in `AppLayer` available
2. **Bundler Compatibility**: Direct `Effect.fork` inside effects causes bundler issues (`e.fork is not a function`)
3. **Detached Execution**: `runFork` returns a fiber that runs independently

```typescript
// daemon.ts - key pattern
const startEngineerInBackground = (input: {...}) => {
  const fiber = AppRuntime.runFork(createEngineerLoopEffect(input))
  running.set(input.engineerID, { ...input, fiber, startedAt: Date.now() })
}

const handleEngineerSpawned = (event) => {
  startEngineerInBackground({ ... })
}

// Lead notification handler - injects messages into lead's session
const handleLeadMessageReceived = (event) => {
  AppRuntime.runFork(Effect.gen(function* () {
    const isLead = yield* coordinator.isLead(event.properties.leadSessionID)
    if (!isLead) return

    const messages = yield* mailbox.receiveByPriority({
      recipientSessionID: event.properties.leadSessionID,
      priority: event.properties.priority,
    })
    if (messages.length === 0) return

    // Inject notification into lead's session
    yield* promptService.prompt({
      sessionID: event.properties.leadSessionID,
      parts: [{ type: "text", text: `[MESSAGE FROM ENGINEER]\n${messages[0].content}` }],
    })
  }))
}

// Subscribe to both events in start()
bus.subscribeCallback(Event.EngineerSpawned, handleEngineerSpawned)
bus.subscribeCallback(MailboxEvent.LeadMessageReceived, handleLeadMessageReceived)
```

## Database Schema

### EngineerSlotTable
```sql
id TEXT PRIMARY KEY,
team_id TEXT NOT NULL,
session_id TEXT NOT NULL,
name TEXT NOT NULL,
state TEXT NOT NULL,  -- 'idle' | 'working' | 'blocked' | 'completed' | 'failed'
current_task TEXT,
started_at INTEGER NOT NULL,
last_heartbeat INTEGER NOT NULL,
time_created INTEGER NOT NULL,
time_updated INTEGER NOT NULL
```

### TeamStateTable
```sql
team_id TEXT PRIMARY KEY,
lead_session_id TEXT NOT NULL,
goal TEXT NOT NULL,
state TEXT NOT NULL,  -- 'pending' | 'active' | 'completed' | 'failed'
engineer_count INTEGER NOT NULL DEFAULT 0,
time_created INTEGER NOT NULL,
time_updated INTEGER NOT NULL
```

### TaskBoardTable
```sql
id TEXT PRIMARY KEY,
team_id TEXT NOT NULL,
title TEXT NOT NULL,
description TEXT NOT NULL,
status TEXT NOT NULL,  -- 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked'
assigned_engineer_id TEXT,
file_scope TEXT,  -- JSON array of file paths
time_created INTEGER NOT NULL,
time_updated INTEGER NOT NULL
```

## Tool Reference

### Lead-Only Tools
| Tool | Purpose |
|------|---------|
| `team_create` | Create a new team with a goal |
| `team_spawn` | Spawn an engineer with a task (optional `model` parameter for LLM selection) |
| `team_decompose` | Break goal into subtasks |
| `team_assign` | Assign unassigned tasks |
| `team_reassign` | Move task to different engineer |
| `team_kill` | Terminate an engineer |
| `team_dissolve` | Shut down entire team |

### Engineer-Only Tools
| Tool | Purpose |
|------|---------|
| `team_status` | Get detailed engineer status |
| `team_report` | Report task completion/failure/blocked (REQUIRED when done) |
| `team_claim` | Claim an unassigned task from the pool |

### Both Lead & Engineer
| Tool | Purpose |
|------|---------|
| `team_monitor` | Check team/task status + fetch unread inbox messages |
| `team_inbox` | Quick mailbox check (with optional `peek` to preview without marking read) |
| `team_message` | Send message to teammate (use engineer ID or "lead") |
| `team_roster` | List all teammates with their IDs and status (for messaging) |
| `team_tasks` | List available tasks (pending, unassigned) that can be claimed |

## Priority System

Tool-level (4-tier) → Mailbox (3-tier):
- `urgent` → `urgent`
- `high` → `inbox`
- `normal` → `inbox`
- `low` → `queue`

## Known Issues / TODOs

### Fixed (2026-04-23)

1. **Engineers not starting** - Fixed by implementing TeamDaemon with `AppRuntime.runFork` pattern
2. **Bundler errors with Effect.fork/catchAll** - Fixed by using `AppRuntime.runFork` directly instead of Effect methods inside effects
3. **Sidebar showing "Idle" instead of "Working"** - Fixed by adding `state` field to `EngineerSpawned` event. The UI was hardcoding `state: "idle"` instead of reading from the event. Now `team_spawn` passes `state: "working"` and `sync.tsx` uses `p.state` from event properties.
4. **Engineer completion reporting** - Added `team_report` tool that engineers must call when done. This updates task status, engineer state, publishes completion events for UI, and sends a mailbox message to the lead with status emoji (✅/🚧/❌) and summary.

5. **Lead inbox integration** - `team_monitor` now automatically fetches and displays unread inbox messages. When lead polls for status, they also see engineer reports. Added `team_inbox` for quick mailbox checks without full status poll.

6. **Event-driven lead notifications** - TeamDaemon subscribes to `LeadMessageReceived` events. When an engineer sends a message (via `team_report`), the daemon catches the event and injects a notification directly into the lead's session via `SessionPrompt.prompt()`. The lead's conversation immediately receives `[MESSAGE FROM ENGINEER]` with the report.

7. **Engineer report files** - Engineers now write detailed findings to `.tmp/report-{name}.md` and send only a brief summary (under 200 chars) via `team_report` with the file path. This keeps mailbox messages lightweight.

8. **Lead no-polling instructions** - Tool descriptions and `team_spawn` output now explicitly tell the lead: "Do NOT poll team_monitor. Engineer will notify you when done." This encourages event-driven waiting.

9. **Real-time progress reporting** - Added `EngineerProgress` event that updates sidebar in real-time. When engineers call `team_status` with a progress description or `team_report` with completion/failure status, an event is published that updates the sidebar's engineer display. The sidebar now shows the engineer's current activity (e.g., "Starting: Review auth...", "Working on: Fix tests...", "✅ completed: Report at .tmp/report-auth.md") instead of just "Working on [task]". The daemon also emits progress events when engineers start and begin working.

10. **Sidebar spinner animation** - Working engineers now display an animated spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) instead of a static dot, providing visual feedback that work is in progress. Idle engineers show a static dot, failed engineers show the error message.

11. **Engineer-to-engineer messaging** - Engineers can now message each other directly using `team_message` with the recipient's engineer ID. The daemon subscribes to `EngineerMessageSent` events and injects messages into engineer sessions, similar to how lead notifications work. Added `team_roster` tool for engineers to discover their teammates' IDs and status. Messages are labeled with sender name (e.g., "[MESSAGE FROM engineer-auth]").

12. **Task claiming** - Engineers can now claim tasks from a shared pool instead of being pre-assigned. Added `team_tasks` tool to list available (pending, unassigned) tasks, and `team_claim` tool to claim a task. After completing a task via `team_report`, engineers can check for more work and claim another. The daemon's engineer prompt now includes instructions for collaboration tools and task claiming workflow.

13. **Per-engineer LLM selection** - Lead can now specify which LLM model each engineer should use via optional `model` parameter in `team_spawn`. Pass `{ providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }` to spawn an engineer using a specific model. If not specified, the engineer inherits the session's default model. This allows leads to route complex tasks to more capable models (e.g., opus) and simpler tasks to faster/cheaper models (e.g., haiku).

14. **Engineer idle behavior** - Fixed engineers restarting work after completing their task when no more tasks were available. The engineer prompt now explicitly instructs: "If NO tasks are available, STOP. Do not keep working or restart your completed task." This prevents engineers from looping indefinitely when the task pool is empty.

15. **Heartbeat monitoring** - Daemon now monitors engineer heartbeats to detect unresponsive engineers. Configuration: heartbeat update every 30s, stale check every 60s, timeout after 5 minutes. When an engineer times out: marks engineer as "failed", releases their task back to "pending" status (can be reclaimed), publishes `EngineerFailed` and `EngineerProgress` events for UI feedback, and interrupts the fiber if still running. Added `listAllEngineers()` to SessionCoordinator for cross-team monitoring.

16. **Graceful shutdown** - Added SIGINT/SIGTERM handlers that clean up database state when OpenCode exits. The `gracefulShutdown()` function: marks all working engineers as "failed", releases their tasks back to "pending" status (can be reclaimed on next startup), marks active teams as "completed" (so they don't appear orphaned), and clears heartbeat intervals. This ensures clean state on restart.

17. **Footer team status indicator** - Added team status to the session footer (always visible, even when sidebar is hidden). Shows animated spinner when engineers are working, with status counts: "⠋ 3 Working · 1 done", "◆ 1 Blocked", "✓ 4 Complete". Uses color coding: green for working/complete, yellow for blocked, red for failed. This ensures team activity is visible even in narrow windows where the sidebar is hidden.

### Open Issues

1. **File conflicts in team_decompose** - LeadCoordinator validates that subtasks have non-overlapping file scopes. May need adjustment for common files.

## Build & Test

```bash
# Build
cd /home/prodrifterdk/Documentos/projects/opencode/packages/opencode
bun run build

# Install
cp dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode

# Run with team tools enabled
OPENCODE_TEAM_ENABLED=true opencode
```

## Logs

Logs are stored in: `~/.local/share/opencode/log/`

Filter for team-related logs:
```bash
grep -i "team\|engineer\|daemon" ~/.local/share/opencode/log/*.log
```

## Shutdown Behavior

When OpenCode exits (Ctrl+C or SIGINT/SIGTERM):

| Component | Behavior | Risk |
|-----------|----------|------|
| Engineer sessions | Effect fibers die with main process | ✅ No zombies |
| Bash child processes | Receive SIGTERM via process group | ✅ Usually clean |
| Database state | Cleaned up via `gracefulShutdown()` | ✅ Clean state |

**Graceful shutdown behavior:**
- SIGINT/SIGTERM triggers `gracefulShutdown()` in the daemon
- All working engineers marked as "failed"
- All in-progress tasks released back to "pending" status
- All active teams marked as "completed"
- Heartbeat intervals cleared
- On next startup, tasks can be reclaimed by new engineers

## Debugging Notes

### Bundler Issues with Effect-ts

When writing code that runs via `AppRuntime.runPromise/runFork`, avoid these patterns that cause bundler errors:

```typescript
// BAD - causes "e.fork is not a function"
const fiber = yield* Effect.fork(someEffect)

// BAD - causes "e.catchAll is not a function"  
someEffect.pipe(Effect.catchAll((e) => ...))

// GOOD - use AppRuntime directly
const fiber = AppRuntime.runFork(someEffect)

// GOOD - use try/catch inside Effect.gen
Effect.gen(function* () {
  try {
    yield* someEffect
  } catch (error) {
    // handle error
  }
})
```

This appears to be a bundler tree-shaking issue where Effect module methods aren't properly resolved when called from callback contexts.
