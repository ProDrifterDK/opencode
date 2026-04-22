# Spike/PoC Learnings — OpenCode Agent Teams

## 2026-04-22: Task 1 — Daemon Mode Validation

### Architecture: Runner (Per-Session Mutex)

- **Source**: `src/effect/runner.ts` (206 lines)
- **State machine**: Idle → Running → Idle (or Idle → Shell → Idle, or Shell → ShellThenRun → Running → Idle)
- **Key insight**: Runner is NOT a global lock. It's per-session via `Map<SessionID, Runner>` in `run-state.ts`
- **ensureRunning()**: Deduplicates concurrent callers — they all share the same Deferred
- **startShell()**: Exclusive mode — throws if runner is busy (this is where BusyError comes from)
- **cancel**: Interrupts fiber, resolves all queued callers with onInterrupt fallback

### Architecture: Session Creation

- **Source**: `src/session/session.ts:393-431`
- Sessions are created with `SessionID.descending()` (sortable ULID)
- parentID establishes hierarchy — `sessions.children(parentID)` queries children
- Each session has its own permission ruleset
- Session data persisted to SQLite via Drizzle ORM

### Architecture: task() Tool

- **Source**: `src/tool/task.ts:40-167`
- Resumption via `task_id`: tries `sessions.get(taskID)`, falls back to `sessions.create()`
- Child session inherits parentID from caller's sessionID
- Permission shaping: can deny todowrite, task, and primary_tools per agent config
- Returns `task_id: <sessionID>` in output for downstream resumption

### Architecture: runLoop

- **Source**: `src/session/prompt.ts:1305-1539`
- Main loop: while(true) with steps
- Each step: get messages → check finish condition → process subtasks/compaction → call LLM
- Subtask handling delegates to child sessions via handleSubtask()
- Compaction triggers when token overflow detected

### SQLite Configuration

- **Source**: `src/storage/db.ts:89-94`
- WAL mode confirmed (`PRAGMA journal_mode = WAL`)
- `busy_timeout = 5000ms` — handles concurrent write contention
- `synchronous = NORMAL` — balance between safety and performance
- WAL allows concurrent readers + single writer

### Effect Patterns (for future code)

- Use `Effect.gen(function* () { ... })` for composition
- Use `Effect.fn("Domain.method")` for traced effects
- Use `InstanceState.make()` for per-directory state
- Use `Effect.forkIn(scope)` for background fibers
- Import via namespace: `import { Runner } from "../src/effect"` (not direct file path)
- Test helpers: `it.live()` from `test/lib/effect.ts` with `testEffect(Layer.mergeAll(...))`
- `provideTmpdirInstance(() => Effect.gen(...))` for tests needing instance context

### Key Validation Results

| Property | Status | Evidence |
|----------|--------|----------|
| N+1 concurrent runners | ✅ PASS | 3 runners (lead + 2 children) concurrent |
| No BusyError cross-session | ✅ PASS | BusyError only within same session |
| No deadlock on cancel | ✅ PASS | 2 runners cancelled concurrently |
| Non-blocking collection | ✅ PASS | Promise.all collects in completion order |
| Sequential reuse | ✅ PASS | 3 sequential tasks on same runner |
| Cancel + resume | ✅ PASS | onInterrupt + new ensureRunning |
| SQLite WAL concurrent writes | ✅ PASS | 5 concurrent writers |
| task_id resumption pattern | ✅ PASS | Reuse via sessions.get fallback |

### Files Read

- `packages/opencode/src/effect/runner.ts` — Runner implementation
- `packages/opencode/src/session/run-state.ts` — Per-session Runner registry
- `packages/opencode/src/session/prompt.ts:1305-1539` — runLoop
- `packages/opencode/src/tool/task.ts:40-167` — task tool
- `packages/opencode/src/session/session.ts:327-431` — BusyError + session creation
- `packages/opencode/src/storage/db.ts:75-115` — SQLite WAL setup
- `packages/opencode/test/effect/runner.test.ts` — Existing Runner tests (494 lines)
- `packages/opencode/test/tool/task.test.ts` — Existing task tool tests

### Risks for Full Implementation

1. **Runner is in-memory only** — process restart loses runner state; session data persists in SQLite
2. **InstanceState scoped per directory** — multiple projects = separate runner maps
3. **Plugin architecture can't spawn sessions** — core changes needed for team orchestration
4. **runLoop is tightly coupled to LLM streaming** — daemon mode needs a way to inject synthetic messages
5. **Permission inheritance** — child sessions need carefully crafted permission rulesets
