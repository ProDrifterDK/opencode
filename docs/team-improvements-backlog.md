# Agent Teams — Improvement Backlog

> Generated 2026-04-24 from a deep-dive review on `spike/team-daemon`.
> Captures every improvement identified after the 2026-04-22 to 2026-04-24
> work sweep, with file paths, severity, and enough context to resume
> after a context-compact.

## Recovery context (read this first if context was compacted)

**Branch**: `spike/team-daemon`
**Working dir for commands**: `/home/prodrifterdk/Documentos/projects/opencode/packages/opencode`
**Last green test count**: `bun test src/team/ src/tool/` → **179 pass, 0 fail** (511 expects, 13 files).
**Sibling docs**:
- `docs/team-tools-implementation.md` — implementation status (may be stale; not auto-updated)
- `docs/superpowers/specs/2026-04-22-team-tools-design.md` — original design spec
- `docs/superpowers/plans/2026-04-22-team-tools.md` — original implementation plan

### Architectural snapshot

The agent teams feature lets a "Lead" session orchestrate up to 5
"engineer" sessions running in parallel as forked Effect fibers in the
**same OpenCode process**. Engineers share the working tree; there is
**no per-engineer git branch isolation** (worktree-per-engineer is the
biggest open architectural item — see A1).

State lives in SQLite via Drizzle ORM. All state operations go through
`SessionCoordinator` which is now **DB-as-source-of-truth** (no in-memory
mirror). The previous `Map<TeamID, …>` cache was removed in this work
to eliminate staleness after direct-SQL writes (e.g. `gracefulShutdown`).

### Service layers (wired in `src/effect/app-runtime.ts` AppLayer)

- `SessionCoordinator` — DB-backed team/engineer state
- `LeadCoordinator` — decompose / assign / monitor / reassign
- `TaskBoardRepo` + `TaskBoardService` — repo + service split for tasks
- `Mailbox` — `DbError`-typed inter-session messaging
- `TeamDaemon` — bus event subscriptions + `setInterval` heartbeat sweep + engineer fiber forks
- `HeartbeatMonitor` — per-team `Scope`-managed monitoring; auto-started in `team_create`, stopped in `team_dissolve`
- `GitManager` — `commitOnCurrentBranch`, `cleanupBranches`, `detectOverlap`, etc.
- `RateLimiter` — per-team budgets + per-team circuit breaker
- `PermissionGuard` — file-scope enforcement; called via `enforceForTool` in `session/prompt.ts` before each `tool.execute.before` plugin trigger

### Key paths

| Concern | Path |
|---|---|
| Service implementations | `packages/opencode/src/team/*.ts` |
| LLM-callable tools (16) | `packages/opencode/src/tool/team.ts` |
| Tool description aggregator | `packages/opencode/src/tool/team.txt` |
| Prompt sources | `packages/opencode/src/command/template/team-{start,status,stop}.txt` |
| Installed prompts | `packages/opencode/.opencode/command/team-{start,status,stop}.md` |
| PermissionGuard hook integration | `packages/opencode/src/session/prompt.ts` (3 sites at lines ~419, ~461, ~583) |
| AppLayer composition | `packages/opencode/src/effect/app-runtime.ts` |
| TUI sidebar (team status) | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/team.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` |
| SQL schema | `packages/opencode/src/team/session-coordinator.sql.ts`, `packages/opencode/src/team/task-board.sql.ts`, `packages/opencode/src/team/mailbox.sql.ts` |

### Tools (16 total)

- **Lead-only**: `team_create`, `team_agents`, `team_decompose`, `team_spawn`, `team_assign`, `team_reassign`, `team_kill`, `team_dissolve`, `team_commit`
- **Engineer-only**: `team_status`, `team_report`, `team_claim`
- **Both**: `team_monitor`, `team_inbox`, `team_roster`, `team_tasks`, `team_message`

### Useful commands

```bash
# Full team+tool suite (expect 179 pass)
bun test src/team/ src/tool/

# TSC filtered to team/tool tree, excluding migration-debt noise
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool)/" \
  | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```

---

## Backlog

Severity legend: **⛔ blocker** | **🔴 high** | **🟡 medium** | **🟢 low**

### Architecture

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| A1 | 🔴 | Shared working tree is the load-bearing limitation. Engineers can race-write the same file silently; `team_commit` semantics are awkward; PermissionGuard is the only safety net. | `src/team/git-manager.ts`, `src/team/daemon.ts` (`createEngineerLoopEffect`, `startEngineerInBackground`), `src/tool/team.ts` (`team_spawn`, `team_dissolve`) | `git worktree add .tmp/team/<engineerID>` per engineer; pass per-engineer cwd into `session.create`; `commitWork` / `mergeBranch` then become real. Scoped cleanup at `team_dissolve` already wired via `cleanupBranches`. |
| A2 | 🟡 | Two heartbeat systems coexist — daemon's `setInterval` sweep AND `HeartbeatMonitor.startTeamMonitoring`. Redundant, conflicting semantics. | `src/team/daemon.ts` (HEARTBEAT_* constants + `checkForStaleEngineers`), `src/team/heartbeat.ts` | Promote HeartbeatMonitor to primary; demote daemon sweep to backstop only when `startTeamMonitoring` fails. |
| A3 | 🟡 | Engineers crash with the Lead (same-process Effect fibers). One OOM kills the team. | `src/team/daemon.ts` (`startEngineerInBackground`), `src/effect/app-runtime.ts` | Subprocess per engineer with IPC over the existing mailbox. Large refactor; defer until A1 lands. |
| A4 | 🟡 | No task DAG / topological scheduling. Lead must manually orchestrate phase-A→phase-B work. | `src/team/task-board.ts`, `src/team/task-board-service.ts`, `src/team/lead-coordinator.ts` (`decompose`) | Extend `Task` with `dependencies: TaskID[]`; auto-claim only unblocked tasks; `team_claim` filters by readiness. |
| A5 | 🟢 | `TeamDaemon` is a singleton — `running` Map is shared across all teams. | `src/team/daemon.ts` (module-level `running` Map) | Refactor to `Map<TeamID, Map<EngineerID, RunningEngineer>>`. |

### Behavior / Correctness

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| B1 | ✅ | **DONE 2026-04-25**. Glob-aware `fileScope` overlap rejection in `decompose` via exported `globOverlap`. Collects all conflicting pairs. Reassign also upgraded. Commit `cf461fd8b`. |
| B2 | ✅ | **DONE 2026-04-25**. PermissionGuard removed entirely — worktree-per-engineer (A1) supersedes runtime fileScope enforcement. `fileScope` retained as planning artifact only. Commit `6ffd0b38f`. |
| B3 | 🟡 | **DEFERRED 2026-04-25**. Wrong abstraction layer: `promptService.loop` is multi-turn — retry replays full conversation (token bomb). Real fix lives inside `session/llm.ts` per-API-call. Out of B-sweep scope. | `src/session/llm.ts` (next sweep) | Wrap individual LLM calls (not the full loop) in `Effect.retry` with `Schedule.exponential("1 second").pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(1)))` for transient classes (5xx, network errors, non-CB 429). |
| B4 | ✅ | **DONE 2026-04-25**. Soft-delete via `archived_at INTEGER` column on `task_board`. All 4 reads filter `archived_at IS NULL`. `dissolveTeam` swapped per-task delete loop for single bulk archive. New repo methods `archiveTeamBoard` + `listArchived`. Commit `462531c9f`. |
| B5 | ✅ | **DONE 2026-04-25**. Mailbox `purgeOlderThan(maxAgeMs)` + 24h TTL constant. Daemon GC sweep on heartbeat tick. Regression tests for kill/dissolve purge wiring via mock contract enforcement. Commits `b73036a8`, `d43b268e8`, `fc06854ae`. |

### UX / UI

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| U1 | 🔴 | No structured team summary at dissolve. After a 30-min run you get one line "Team dissolved." Engineers' reports + commits + task outcomes are lost to the user. | `src/tool/team.ts` (`TeamDissolveTool` ~line 711), `src/team/lead-coordinator.ts` (`monitor`), `src/team/task-board-service.ts` | Generate a markdown report from engineers + tasks + reports + commits; write to `.tmp/team-<teamID>-summary.md`; surface path in tool output. |
| U2 | 🟡 | Lead can't jump into an engineer's session from the TUI. | `src/cli/cmd/tui/feature-plugins/sidebar/team.tsx`, `src/cli/cmd/tui/routes/session/sidebar.tsx` | Sidebar click → opens engineer session; CLI: a new `team_open <engineerID>` tool. |
| U3 | 🟡 | Engineer naming is auto-generated (`engineer-1`, `engineer-2`). Hard to identify roles at a glance. | `src/team/session-coordinator.ts` (`spawnEngineer`), `src/tool/team.ts` (`team_spawn`) | Default name from a verb derived from task title (`engineer-refactor-auth`). |
| U4 | 🟡 | `team_monitor` doesn't show rate-limit pressure — Lead doesn't know the team is being throttled until queue stalls. | `src/tool/team.ts` (`TeamMonitorTool` ~line 150), `src/team/lead-coordinator.ts` (`monitor`), `src/team/rate-limiter.ts` (`getStats`) | Include `RateLimiter.getStats(teamID)` in monitor's response. |
| U5 | 🟢 | Prompt is large (~100 lines after my recent edits). Big context cost on every Lead invocation. | `src/command/template/team-start.txt`, `.opencode/command/team-start.md` | Split into short executive flow + reference appendix loaded on demand. |
| U6 | 🟢 | No interactive replan — `team_reassign` moves a task but can't edit its description. | `src/tool/team.ts` (new `TeamRetaskTool`) | Add `team_retask({ taskId, title?, description?, fileScope? })` Lead-only. |

### Efficiency

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| E1 | 🟡 | Token estimate hardcoded `8000` per engineer in `ENGINEER_TOKEN_ESTIMATE`. Reality varies 10×, drifting the per-team budget. | `src/team/daemon.ts` (`ENGINEER_TOKEN_ESTIMATE`), `src/session/llm.ts` (response usage) | Track actual token usage from `LLM.Service` responses; pass to `rateLimiter.release(teamID, engID, actualTokens)`. |
| E2 | 🟢 | When a Lead picks an agent without a pinned model, the engineer inherits the Lead's model — including for trivial subtasks. *Note: routing is provider-agnostic via OpenCode agents; this is a prompt-side nudge, not a tier system.* | `src/command/template/team-start.txt` (Step 2: Decompose), `docs/team-tools-implementation.md` | Prompt nudge: annotate `complexity` per subtask in `team_decompose`; if user has agents pinned to faster providers, prefer them for low-complexity tasks. Documentation example for "good agent setup for teams." |
| E3 | 🟢 | Bus dual-publish in `publishTeamEvent` — both local Bus and GlobalBus. Likely one is unused. | `src/team/events.ts` (`publishTeamEvent`) | Investigate which is consumed by the TUI; remove the other. |
| E4 | 🟢 | No caching on `team_agents` — re-queries provider list every call. | `src/tool/team.ts` (`TeamAgentsTool`) | Memoize with a short TTL (~30s). |

### Security / Robustness

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| S1 | 🟡 | `team_message` flooding from a rogue engineer. No rate limit on inter-team messages — engineer could spam Lead's inbox. | `src/tool/team.ts` (`TeamMessageTool`), `src/team/mailbox.ts` | Cap at e.g. 10 messages/min per engineer; reject with a clear error past threshold. |
| S2 | 🟡 | `commitOnCurrentBranch` commits **all** working-tree changes — including unrelated user-staged work. | `src/team/git-manager.ts` (`commitOnCurrentBranch`) | Either scope to expected files (read from active engineers' fileScopes via SessionCoordinator), or refuse if `git status` shows files outside any active engineer's scope. |
| S3 | 🟢 | No eager validation that requested `agentName` exists at `team_spawn` time. Falls through to `session.create` failure. | `src/tool/team.ts` (`TeamSpawnTool`) | Call `agents.get(agentName)` early; return a clear "Agent not found" error with available list. |

### OpenCode-native opportunities

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| O1 | 🟡 | No multi-provider failover. When a team's circuit breaker trips on the primary provider, engineers stall instead of failing over. | `src/tool/team.ts` (`TeamSpawnTool`), `src/team/daemon.ts` (`createEngineerLoopEffect`), `src/team/rate-limiter.ts` | Add `fallbackAgent` param to `team_spawn`; on `CircuitBreakerOpenError`, switch the engineer's session to the fallback agent's provider. |
| O2 | 🟡 | Team events not exposed through the plugin system. External plugins can't observe team lifecycle. | `src/team/events.ts`, `src/plugin/index.ts` | Add `plugin.trigger("team.engineer.spawned", …)` etc. Mirror the `tool.execute.before` integration model already used by PermissionGuard. |
| O3 | 🟢 | Team transcripts not shareable as a single artifact. Engineer sessions are linked to Lead via `parentID` but no surface to share the whole subtree. | `src/share/*`, `src/team/session-coordinator.ts` | Expose "share whole subtree" command; team-aware share URL. |
| O4 | 🟢 | No `/team-resume` slash command. Teams in `terminated` (not `dissolved`) state could be re-attached. | `src/command/template/`, `.opencode/command/`, `src/team/session-coordinator.ts` (state="terminated" recovery) | Add `/team-resume <teamID>` that re-attaches engineers to a previously-terminated team. |

---

## Recommended next priorities (by leverage)

1. **A1 — worktree-per-engineer** (1–2 days). Unlocks real parallelism, makes commit/merge real, makes PermissionGuard defense-in-depth instead of the only safety net. Highest leverage by far.
2. **B1 — fileScope overlap validation** (~1 hour). `detectOverlap` already exists as a pure function; just wire it into `team_decompose`.
3. **U1 — structured dissolve summary** (~2 hours). Big visible value with tiny code.
4. **B2 — extend PermissionGuard to bash** (~3 hours). Real security gap given engineers have bash access.
5. **O1 — failover agent on `team_spawn`** (~3 hours). Plays to OpenCode's provider-agnostic strengths.
6. **O2 — team events through plugin system** (~3 hours). Enables ecosystem.

---

## What was completed in the 2026-04-22 → 2026-04-24 work sweep

(Cross-reference with `git diff` against `e67fc4592`. Useful for resuming after context-compact.)

### Original four ultrawork items
- **events.ts publish-noise suppression** — narrow swallow of "No context found for instance" errors when `publishTeamEvent` is called from synchronous contexts (e.g. `gracefulShutdown`).
- **Per-team rate-limit scoping** — `RateLimiter` state replaced single global counters with `Map<TeamID, TeamState>`; `acquire`/`release`/`report429`/`resetCircuitBreaker` now take `teamID`; new `getStats(teamID)` and `forgetTeam(teamID)`. +3 isolation tests.
- **`team_commit` tool + `GitManager.commitOnCurrentBranch`** — Lead-only `git add --all && git commit --allow-empty -m <msg>` on the current branch, no per-engineer checkout.
- **HeartbeatMonitor auto-start** — added `startTeamMonitoring` / `stopTeamMonitoring` with internal `Map<TeamID, Scope.Closeable>` and `Scope.make` / `Scope.provide` / `Scope.close(scope, Exit.void)` lifecycle. Wired into `team_create` and `team_dissolve`.

### Earlier P0 / P1 / P2 work (same session)
- **DB-as-source-of-truth refactor of `SessionCoordinator`** — eliminated map staleness; centralised `rowToSlot`/`rowToTeam` translators; fixed pre-existing `agent_name`/`agent_color` hydration bug.
- **Pre-existing `events.test.ts` failures fixed** — schema is 9 events not 8, `EngineerSpawned` requires concrete task fields not nullable taskId.
- **Daemon heartbeat sweep restored** after the WS-C regression deleted it without a working replacement.
- **Reverted broken `plugin/index.ts` cycle** introduced by WS-D's incomplete attempt (created `session/session.ts → … → plugin/index.ts → session-coordinator.ts → session/session.ts` cycle).
- **`PermissionGuard.enforceForTool` wired into `session/prompt.ts`** at all three `tool.execute.before` sites (native tool, MCP tool, TaskTool).
- Wired `RateLimiter`, `GitManager`, `HeartbeatMonitor`, `PermissionGuard` into `AppLayer`.
- **Rewrote `team-status.md` and `team-stop.md`** with real `team_*` tool names instead of Effect service method names that LLMs can't actually call.

### Iteration 2 / 3 cleanup
- **Tests for `team_commit`** (+4 cases in new `src/team/team-commit-tool.test.ts`) and **HeartbeatMonitor scope APIs** (+4 cases in `src/team/heartbeat.test.ts`).
- **`final-qa-lifecycle.test.ts` typing drift cleared** (18 tsc errors → 0): `teamID/teamId` casing, `EngineerSlot` fixture missing `agentName/agentColor`, mock signatures vs. `MessageSummarizer` interface, `AssignInput` shape vs. `EngineerStateRecord[]`.
- **`team_commit` documented** in `team-start.txt`, `.opencode/command/team-start.md`, `src/tool/team.txt` (new Step 7 "Checkpoint Progress", tool count 15 → 16).
- **`daemon.ts` Effect v3 → v4 cleanup** (6 non-migration tsc errors → 0): `Effect.catchAll` → `Effect.catch` / `Effect.ignore`, `yield* Fiber.interrupt`, `TaskBoardID` cast after null narrowing, removed unused error param annotation.

---

## What was completed in the 2026-04-25 Behavior/Correctness sweep (B1, B2, B4, B5)

Spec: `docs/superpowers/specs/2026-04-25-team-behavior-correctness-sweep-design.md`
Plan: `docs/superpowers/plans/2026-04-25-team-behavior-correctness-sweep.md`

### Sequence: B5 → B1 → B4 → B2

- **B5 — Mailbox TTL + age-based GC** (commits `b73036a8`, `d43b268e8`, `fc06854ae`)
  - New constant `MAILBOX_MAX_AGE_MS = 86_400_000` (24h orphan-cleanup TTL).
  - `mailbox.purgeOlderThan(maxAgeMs): Effect<number, DbError>` deletes rows by `lt(created_at, cutoff)` and returns purged count.
  - Daemon GC sweep `purgeStaleMailboxMessages` runs alongside `checkForStaleEngineers` on each `HEARTBEAT_CHECK_INTERVAL` tick. Logs via `Cause.pretty`.
  - 3 regression tests in `lifecycle-integration.test.ts` lock the `kill ⇒ mailbox empty` and `dissolve ⇒ all mailboxes empty` contract via mock `purgeViaMailbox` helper that delegates to the real `Mailbox.purge`.
  - **Limitation noted**: real-DB test for `purgeOlderThan` predicate not added — no real-DB test infra exists in repo yet.

- **B1 — Glob-aware fileScope overlap rejection** (commit `cf461fd8b`)
  - `globOverlap` exported from `src/team/git-manager.ts:106`.
  - `LeadCoordinator.decompose` replaces naive exact-match `filesOverlap` with O(n²) glob-aware all-pairs check, collecting every conflict into a single `FileScopeConflictError`.
  - Error message format: `Overlapping fileScopes detected. Re-decompose with disjoint scopes:\n  - "<a>" vs "<b>": [<aFiles>] / [<bFiles>]`.
  - `LeadCoordinator.reassign` upgraded to the same glob-aware check (would otherwise have broken when `filesOverlap` was deleted).
  - 5 new tests + 1 message-format update in `lead-coordinator.test.ts`.

- **B4 — Soft-delete task board on dissolve** (commit `462531c9f`)
  - New nullable `archived_at INTEGER` column on `task_board` via migration `20260425175151_sudden_steel_serpent`.
  - All 4 reads in `task-board.ts` filter `archived_at IS NULL` (`update`'s read-then-write check, `list`, `get`, `listReadyTasks`).
  - New repo methods `archiveTeamBoard(teamId)` (idempotent bulk archive, filters already-archived) and `listArchived(teamId)`.
  - `SessionCoordinator.dissolveTeam` swaps per-task delete loop for single bulk archive call.
  - 5 new tests in `task-board-service.test.ts` plus mock extensions in 4 sibling test files for tsc compatibility.
  - Migration runner is custom (`src/storage/db.ts:64-82`, reads `migration.sql` per dir, ignores `meta/_journal.json`) — generated migration trimmed to only the new ALTER. `snapshot.json` removed (not used by runner).

- **B2 — PermissionGuard removed entirely** (commit `6ffd0b38f`)
  - Worktree-per-engineer (A1) supersedes runtime fileScope enforcement. Engineers now have same permissions as Lead.
  - Removed 3 guard sites in `src/session/prompt.ts` (native tool, MCP tool, TaskTool).
  - Deleted `src/team/permission-guard.ts` + `permission-guard.test.ts` (-22 tests).
  - Dropped `permissionGuardLayer` from AppLayer composition.
  - Stripped `memPermissionGuard` fixture from `final-qa-lifecycle.test.ts`.
  - Refreshed `team-start.txt` Lead prompt to remove stale PermissionGuard reference.
  - **`fileScope` retained** as planning artifact — used by B1 overlap detection and surfaced in `team_monitor` / `team_roster` outputs.

### B3 deferred

Wrong abstraction layer. `promptService.loop` is a multi-turn LLM conversation loop; wrapping it in `Effect.retry` would replay all prior turns on transient failure (token bomb). Real fix lives inside `session/llm.ts` at per-API-call granularity, where idempotent retry is safe. Out of B-sweep scope. Schedule expression for the future implementer is documented in the spec.

### Test count progression

| Item | Before | After | Delta |
|---|---|---|---|
| B5 base | 238 | 241 | +3 |
| B5 strengthen | 241 | 241 | +0 (refactored) |
| B5 cleanup | 241 | 242 | +1 (boundary) |
| B1 | 242 | 247 | +5 |
| B4 | 247 | 252 | +5 |
| B2 | 252 | 230 | -22 (deleted permission-guard tests) |

Final: **230 pass / 0 fail** in `src/team/ src/tool/ src/session/`.

### Open follow-ups (not blockers)

- B1: dedupe `conflictingFiles` via `[...new Set(...)]` in `FileScopeConflictError` payload.
- B1: add reassign-glob test (currently no direct test of `reassign`'s overlap path).
- B5: thread `MAILBOX_MAX_AGE_MS` through `Config` for ops/dev override.
- B5: add `created_at` index on `MailboxTable` if mailbox sizes grow.
- B5: add real-DB test for `purgeOlderThan` predicate once shared real-DB test infra exists.
- General: `meta/_journal.json` absence means future `bunx drizzle-kit generate` will re-emit stale ALTERs. Each implementer needs to manually trim. Pre-existing repo workflow issue, worth fixing.

---

## Effect v4 migration notes (codebase-wide debt, not in scope for teams improvement)

Patterns observed during this work:
- `Effect.catchAll` — gone; use `Effect.catch` (exported as `catch_` internally, surfaces as `Effect.catch`)
- `Effect.catchAll(() => Effect.void)` swallow-all → use `Effect.ignore` (cleaner)
- `Fiber.RuntimeFiber` — renamed; consult `node_modules/.bun/effect@4.0.0-beta.48/node_modules/effect/dist/Fiber.d.ts`
- `Fiber.interruptFork` → `Fiber.interrupt` with explicit fork pattern
- `Scope.CloseableScope` → `Scope.Closeable`
- `Scope.extend` → `Scope.provide`
- TS35 advisory warnings about untagged `Error` in failure channels → migrate to `Schema.TaggedErrorClass`
