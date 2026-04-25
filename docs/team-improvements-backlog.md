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
| U1 | ✅ | **DONE 2026-04-25**. `TeamDissolveTool` writes structured markdown summary to `<repoRoot>/.tmp/team-<teamID>-summary.md`. New pure helper `dissolve-summary.ts` builds report from tasks + engineers + duration. Output line surfaces path. Best-effort write (dissolve never fails on summary error). Commit `9c8488fc7`. |
| U2 | ✅ | **DONE 2026-04-25**. TUI engineer rows now navigate to engineer session via `onMouseDown` calling `props.api.route.navigate("session", {sessionID})`. `sessionID` plumbed through `engineer.spawned` event into sync state. Commit `e3ce6de0c`. |
| U3 | ✅ | **DONE 2026-04-25**. `deriveEngineerName(taskTitle, fallbackIndex)` pure helper (new `engineer-naming.ts`) yields `engineer-<verb>-<noun>` from task title. 16 unit tests cover stopword stripping, fallback paths, truncation, unicode. Commit `8d320a779`. |
| U4 | ✅ | **DONE 2026-04-25**. `LeadCoordinator.monitor` now calls `RateLimiter.getStats(teamId)` and attaches result to `ProgressReport.rateLimits`. `formatStatus` renders `Rate limits: tokens X/Y (Z%), active N, queued M, CB: <state>`. Required fixing `LeadCoordinator.layer` to also provide `RateLimiter.layer` in AppLayer. Commit `7282b5e1c`. |
| U5 | ✅ | **DONE 2026-04-25**. Lead prompt split: `team-start.txt` trimmed from 139→37 lines (executive flow only). New `team-reference.txt` (125 lines) holds tools/fileScope/errors/examples. Lead reads reference on demand. Mirrored to `.opencode/command/team-{start,reference}.md`. Commit `bac98a05f`. |
| U6 | ✅ | **DONE 2026-04-25**. New `team_retask({taskId, title?, description?, fileScope?})` Lead-only tool. Status guard rejects `in-progress`/`completed`/`failed`. Empty-update guard. fileScope changes trigger glob-overlap check vs other active tasks. Tool count 16→17. Commit `32337be2e`. |

### Efficiency

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| E1 | ✅ | **DONE 2026-04-25**. New `RateLimiter.reconcile(teamID, engID, estimated, actual)` adjusts `tokensUsedThisMinute` by `actual - estimated` (clamped ≥0). Engineer-loop extracts tokens from `step-finish` parts of returned message and reconciles best-effort. Estimate stays as upfront budget gate. Limitation: only final assistant message captured (multi-turn partial). Commit `a228e22ce`. |
| E2 | ✅ | **DONE 2026-04-25**. Optional `complexity?: "low"\|"medium"\|"high"` added to `SubtaskSpec` + `team_decompose` Zod schema. Pure pass-through hint — no DB migration. Tool description nudges Lead. Reference doc shows JSON example pinning faster agents to low-complexity tasks. Commit `02377749d`. |
| E3 | ✅ | **DONE 2026-04-25** (no path dropped). Investigation found dual-publish is intentional and non-redundant: `Bus.publish` reaches daemon (heartbeat setup on EngineerSpawned), `GlobalBus.emit({directory:"global"})` reaches TUI sync (which filters on `directory === "global"` so `Bus.publish`'s instance-scoped GlobalBus emission is silently dropped). Comment expanded to document routing rationale. Commit `84912ff6d`. |
| E4 | ✅ | **DONE 2026-04-25**. Module-level cache `_agentsCache: { value, expiresAt }` in `src/tool/team.ts`. `TeamAgentsTool.execute` checks cache before calling `agentService.list()`. New constant `TEAM_AGENTS_CACHE_TTL_MS = 30_000`. 6 boundary tests. Commit `111bde140`. |

### Security / Robustness

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| S1 | ✅ | **DONE 2026-04-25**. Per-sender sliding-window rate limiter (10 msgs/60s) in new `message-rate-limiter.ts`. `TeamMessageTool` checks before `mailbox.send`; rejects 11th in window with `Rate limit exceeded` + retry-after seconds. 5 boundary tests. Commit `d24df0f96`. |
| S2 | ✅ | **DONE 2026-04-25 (defense-in-depth)**. Original premise (`team_commit` sweeps unrelated WIP via `git add --all`) was made **stale by A1**: post-worktree, `team_commit` uses `gitManager.mergeBranch` (squash merge), not `commitOnCurrentBranch`. The latter is now dead code. Hardening still applied: `commitOnCurrentBranch(input: { message, fileScopes? })` — non-empty union → `git add -- <pathspec>`, empty → `--all` fallback. Future-proofs the method if a consumer is reintroduced. Plus 14 unrelated stub fixes unblocked type-safe paths in tests. Commit `f64293ff1`. |
| S3 | ✅ | **DONE 2026-04-25**. `TeamSpawnTool.execute` validates `agentName` against `_agentsCache` (E4) at tool boundary before any state mutation. Error format: `Agent '<name>' not found. Available: <comma-separated list>` (filters hidden/native agents). 9 boundary tests including case-insensitive match and cache hit/miss. Commit `99ecbc331`. |

### OpenCode-native opportunities

| ID | Sev | Issue | Files | Fix sketch |
|----|---|---|---|---|
| O1 | ✅ | **DONE 2026-04-25**. New `fallbackAgent?: string` param on `team_spawn`. Persisted via new `fallback_agent_name` column on `engineer_slot` (migration `20260425180000_fallback_agent_column`). Tool validates both primary + fallback against E4 cache. Engineer-loop catches `CircuitBreakerOpenError` and re-runs `attemptTask` with the fallback model on the SAME session via `promptService.prompt({sessionID, model: fallbackModel})` — no respawn needed. Resets per-team breaker between attempts. CLI subprocess receives both models via `--fallback-provider-id`/`--fallback-model-id` flags. EngineerSpawned event extended with fallback fields. Commit `1ae7a09f8`. |
| O2 | ✅ | **DONE 2026-04-25**. Module-level hook notifier `notifyPluginEvent({type, properties})` added to `src/plugin/index.ts` — uses live hook-getter registration so the call works from sync code. `publishTeamEvent` calls it on the lead path only (subprocess branch short-circuits). Plugin failures are caught and logged, never blocking Bus + GlobalBus emissions. Plugins subscribe via `event` hook (same path as `bus.subscribeAll`). 4 boundary tests. Commit `bb12deb8c`. **Deviation**: spec suggested `Plugin.trigger(eventName, payload)` but that API requires Effect context + `TriggerName` registration — used `Hooks["event"]` path instead, functionally equivalent. |
| O3 | ✅ | **DONE 2026-04-25**. New `team_share(teamID)` Lead-only tool. Calls `SessionShare.Service.share(sessionID)` once for the Lead and once per engineer (per-session API — N+1 calls). Returns structured text output: `Lead: <url>` + `Engineers (N): <name> (<task>): <url>`. `requireLead` guard. 4 tests covering 0-engineer, 2-engineer, non-lead rejection, team-not-found. Tool count 18→19. Commit `cc915da9e`. |
| O4 | ✅ | **DONE 2026-04-25**. New `/team-resume <teamID>` slash command + `team_resume(teamID)` LLM tool. `SessionCoordinator.resumeTeam` flips state `terminated → active`. `TeamDaemon.resumeTeamMonitoring` re-attaches heartbeat (idempotent), resets `in-progress` tasks to `pending` (subprocess died mid-task), re-spawns engineers in `working`/`blocked` state via `engineerProcessManager.spawn`. Reuses worktrees via existing idempotent `createEngineerWorktree`. **No `isLead` guard** — by design: a fresh session resuming a terminated team would otherwise be locked out. State-machine check (`terminated` only) is the real authorization. 6 tests. Tool count 19→20. Commit `17c1dbc49`. |

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

---

## What was completed in the 2026-04-25 UX/UI sweep (U1-U6)

Run via ultrawork — batch A (U2/U3/U5) parallel, batch B (U1/U4/U6) sequential to avoid `tool/team.ts` merge conflicts.

### Commits

- **U3 — Smarter engineer naming** (`8d320a779`): pure helper `deriveEngineerName(taskTitle, fallbackIndex)` in new `engineer-naming.ts` produces `engineer-<verb>-<noun>` from task title. 20-word stopword list (articles/prepositions only — verbs preserved). `session-coordinator.spawnEngineer` accepts `taskTitle?` and uses helper for default name. 16 unit tests.
- **U5 — Lead prompt split** (`bac98a05f`): `team-start.txt` trimmed from 139→37 lines (executive flow only). New `team-reference.txt` (125 lines) holds tool API, fileScope rules, error handling, examples. Lead reads reference on demand. Mirrored to `.opencode/command/team-{start,reference}.md`.
- **U2 — TUI engineer-row navigation** (`e3ce6de0c`): engineer rows in team sidebar now navigate to engineer session via `onMouseDown` → `api.route.navigate("session", {sessionID})`. `sessionID` plumbed through `engineer.spawned` event into sync state. Plugin TUI types updated to expose `sessionID`/`progressText`/`agentName`/`agentColor`.
- **U1 — Structured dissolve summary** (`9c8488fc7`): new pure helper `dissolve-summary.ts` builds markdown report (tasks by status, engineers, duration). `TeamDissolveTool` snapshots state pre-archive, writes `<repoRoot>/.tmp/team-<teamID>-summary.md` post-archive. Best-effort write (dissolve never fails on summary error). 7 unit tests.
- **U4 — Rate-limit pressure in monitor** (`7282b5e1c`): `ProgressReport` extended with `rateLimits?: RateLimiterStats | null`. `LeadCoordinator.monitor` calls `rateLimiter.getStats(teamId)`. `formatStatus` renders `Rate limits: tokens X/Y (Z%), active N, queued M, CB: <state>`. Required fixing `LeadCoordinator.layer` to provide `RateLimiter.layer` in AppLayer + `HeartbeatMonitor` inline layer. 9 new tests.
- **U6 — `team_retask` tool** (`32337be2e`): new Lead-only tool `team_retask({taskId, title?, description?, fileScope?})`. Status guard rejects `in-progress`/`completed`/`failed`. Empty-update guard. fileScope changes trigger B1's glob-overlap check vs other active tasks. Tool count 16→17. 11 new tests.

### Test count progression (U-sweep)

| Item | Before | After | Delta |
|---|---|---|---|
| U3 | 230 | 246 | +16 |
| U5 | 246 | 246 | +0 (prompt-only) |
| U2 | 246 | 246 | +0 (TUI-only, no team-suite tests) |
| U1 | 246 | 253 | +7 |
| U4 | 253 | 258 | +5 (after factoring fix-up tests) |
| U6 | 258 | 269 | +11 |

Final: **269 pass / 0 fail** in `src/team/ src/tool/`.

### Open follow-ups (non-blockers)

- U2: TUI test coverage. The TUI sidebar navigation is exercised manually only — no automated TUI test infra.
- U4: monitor's `formatStatus` text format unstable as feature evolves; consider structured-only output for LLM consumption.
- U6: `team_retask` does not surface task changes to engineers if a task is reassigned mid-flight (locked to `pending`/`blocked` only — by design, but document edge cases).

---

## What was completed in the 2026-04-25 Efficiency sweep (E1-E4)

Run via parallel-then-sequential dispatch — E1 + E3 fired in parallel, E4 + E2 sequential.

### Commits

- **E3 — Bus dual-publish documented** (`84912ff6d`): Investigation confirmed both bus paths in `publishTeamEvent` serve distinct subscribers. `Bus.publish` reaches daemon for `EngineerSpawned` heartbeat setup. `GlobalBus.emit({directory:"global"})` reaches TUI via SDK SSE stream — TUI filters `directory === "global"`, so `Bus.publish`'s instance-scoped GlobalBus emission is dropped. Dual-publish kept; rationale documented in `events.ts:122-141`.
- **E1 — Real token usage reconciliation** (`a228e22ce`): New `RateLimiter.reconcile(teamID, engID, estimatedTokens, actualTokens)` adjusts `tokensUsedThisMinute` by `actual - estimated` (clamped ≥0). Engineer-loop extracts tokens from `step-finish` parts of `promptService.loop` returned message and reconciles best-effort (`Effect.ignore` on failure). Estimate stays as upfront budget gate. Limitation: only the final assistant message is captured — multi-turn token totals are partial. Documented in `extractTokensFromMessage` JSDoc.
- **E4 — `team_agents` cache** (`111bde140`): Module-level `_agentsCache: { value, expiresAt }` in `src/tool/team.ts`. `TeamAgentsTool.execute` returns cached value within TTL, queries `agentService.list()` on miss. New constant `TEAM_AGENTS_CACHE_TTL_MS = 30_000`. 6 boundary tests in `team-agents-cache.test.ts` (TTL constant value, first-call queries, hit-within-TTL, re-query after expiry, exact boundary, instance isolation).
- **E2 — `complexity` field on SubtaskSpec** (`02377749d`): Optional `complexity?: "low"|"medium"|"high"` added to `SubtaskSpec` interface and `team_decompose` Zod schema. Pure pass-through hint — NO DB migration. Tool description nudges: `"Annotate complexity per subtask (low/medium/high) to help match to faster agents in heterogeneous teams."` Reference doc shows JSON example pinning faster agents to low-complexity tasks. Debug log line on annotated tasks.

### Test count progression (E-sweep)

| Item | Before | After | Delta |
|---|---|---|---|
| E3 | 269 | 269 | +0 (docs only) |
| E1 | 269 | 278 | +9 |
| E4 | 278 | 284 | +6 |
| E2 | 284 | 286 | +2 |

Final: **286 pass / 0 fail** in `src/team/ src/tool/`.

### Open follow-ups

- E1: token capture is partial for multi-turn sessions. Future fix would call into a sessions service to aggregate `step-finish` parts across all assistant messages, not just the final one.
- E2: `complexity` is pass-through only. No automated routing yet. Future O-sweep item could read `complexity` and choose agents at `team_assign` time.
- E4: cache has no manual invalidation. If a user adds a provider mid-session, the new agent doesn't appear until 30s. Acceptable for now.

---

## What was completed in the 2026-04-25 Security/Robustness sweep (S1-S3)

Sequential dispatch — all 3 items touched `tool/team.ts`. Order: S3 → S1 → S2.

### Commits

- **S3 — Eager `agentName` validation in `team_spawn`** (`99ecbc331`): `TeamSpawnTool.execute` now calls into the E4 `_agentsCache` at the tool boundary before any state mutation. If lookup fails, returns `Agent '<name>' not found. Available: <list>` (filters hidden/native agents). 9 boundary tests covering valid name, case-insensitive match, unknown name with full error message, empty string, no-visible-agents edge case, cache hit, cache miss.
- **S1 — `team_message` per-sender rate limit** (`d24df0f96`): New `src/team/message-rate-limiter.ts` with module-level `Map<senderID, number[]>` sliding-window limiter. `checkAndRecordMessage(senderID)` prunes timestamps older than `MESSAGE_RATE_WINDOW_MS = 60_000` and rejects if remaining count ≥ `MESSAGE_RATE_LIMIT_PER_MIN = 10`. `TeamMessageTool` gates before `mailbox.send`; rejection returns `Rate limit exceeded: 10 messages/min per sender. Retry in ~Ns.`. 5 tests including allow-10, reject-11th, window-reset, per-sender isolation, exact-boundary pruning.
- **S2 — `commitOnCurrentBranch` pathspec scope** (`f64293ff1`): Hardening applied as defense-in-depth. **Important context**: post-A1 (worktree-per-engineer), `team_commit` uses `gitManager.mergeBranch` (squash merge), NOT `commitOnCurrentBranch`. The latter is now dead code with no live caller. Original S2 premise (sweep unrelated WIP via `git add --all`) is stale. Hardening still applied: signature changed to `(input: { message, fileScopes? })`. Non-empty union → `git add -- <pathspec>`, empty → `--all` fallback. Future-proofs the method. Bonus: 14 unrelated stub fixes (`makeGitManagerStub`/`makeTaskBoardStub` were missing methods added by A1/B4) unblocked type-safe paths in `team-commit-tool.test.ts`.

### Test count progression (S-sweep)

| Item | Before | After | Delta |
|---|---|---|---|
| S3 | 286 | 295 | +9 |
| S1 | 295 | 300 | +5 |
| S2 | 300 | 304 | +4 (+ 14 unrelated stub-fix tests unblocked) |

Final: **304 pass / 0 fail** in `src/team/ src/tool/`.

### Open follow-ups / observations

- S2's hardening is unused today. Either reintroduce a consumer (e.g., a Lead-side "checkpoint" that bundles current-tree changes) or remove `commitOnCurrentBranch` entirely in a future cleanup. Keeping it for now since the cost is small and the abstraction may have value if a non-merge commit path returns.
- S1's rate limiter is per-process. If the daemon restarts, the window resets. Acceptable for transient flooding protection; not a hardening against persistent abuse (which would need DB-backed counters).
- S3 reuses E4's cache, so an agent added mid-session is invisible to validation for up to 30s. Same caveat as E4 — acceptable.

---

## What was completed in the 2026-04-25 OpenCode-native sweep (O1-O4)

Sequential dispatch — all 4 items touch `src/tool/team.ts`. Order: O1 → O2 → O4 → O3 (severity-driven; 🟡 first).

### Commits

- **O1 — Multi-provider failover** (`1ae7a09f8`): New `fallbackAgent?: string` param on `team_spawn`. Persisted via `engineer_slot.fallback_agent_name` column (migration `20260425180000_fallback_agent_column`, single non-destructive ALTER). Tool validates both primary + fallback agents via E4 `_agentsCache`. Engineer-loop catches `CircuitBreakerOpenError` from `RateLimiter.acquire`, calls `rateLimiter.resetCircuitBreaker(teamID)` (assumption: fallback uses different provider), and re-runs `attemptTask` with the fallback model on the SAME session via `promptService.prompt({sessionID, model: fallbackModel})` — no respawn. CLI subprocess receives both models via `--fallback-provider-id`/`--fallback-model-id` flags. `EngineerSpawned` event extended with `fallbackAgent`/`fallbackProviderID`/`fallbackModelID` fields. 9 new tests including failover decision logic with real `RateLimiter.layer`.
- **O2 — Plugin trigger system for team events** (`bb12deb8c`): Module-level hook notifier `notifyPluginEvent({type, properties})` added to `src/plugin/index.ts`. Uses `_registerHooksGetter(() => hooks)` registered at layer init so the live hook list is accessible from sync code. `publishTeamEvent` calls `notifyPluginEvent` on the lead path AFTER `Bus.publish` + `GlobalBus.emit` (subprocess branch short-circuits before this). Plugin failures caught + logged, never propagating to Bus/GlobalBus. Plugins subscribe via the `event` hook — same path as `bus.subscribeAll`. **Deviation**: spec suggested typed `Plugin.trigger(eventName, payload)` API, but that requires Effect context + `TriggerName` registration in `Hooks` interface. Used `Hooks["event"]` path instead — functionally equivalent. 4 new tests.
- **O4 — `/team-resume` slash command + `team_resume` tool** (`17c1dbc49`): `SessionCoordinator.resumeTeam(teamID)` flips state `terminated → active`. `TeamDaemon.resumeTeamMonitoring(teamID)` re-attaches heartbeat (idempotent via `isMonitoring` check), resets `in-progress` tasks to `pending` (the subprocess that owned them is gone), and re-spawns engineers in `working`/`blocked` state via `engineerProcessManager.spawn`. Reuses worktrees via existing idempotent `createEngineerWorktree`. **No `isLead` guard** — intentional: a fresh session resuming a terminated team would otherwise be locked out. State-machine check (`terminated` only) is the real authorization boundary. New slash command at `src/command/template/team-resume.txt` + `.opencode/command/team-resume.md`. 6 new tests. Tool count 18→19.
- **O3 — `team_share` tool** (`cc915da9e`): New Lead-only tool. Calls `SessionShare.Service.share(sessionID)` once for the Lead session and once per engineer session (per-session API — N+1 calls). Returns structured text output:
  ```
  Team <id> shared:
    Lead: <url>
    Engineers (N):
      engineer-X (Foo Task): <url>
      engineer-Y (Bar Task): <url>
  ```
  `requireLead` guard. 4 tests. Tool count 19→20.

### Test count progression (O-sweep)

| Item | Before | After | Delta |
|---|---|---|---|
| O1 | 304 | 313 | +9 |
| O2 | 313 | 317 | +4 |
| O4 | 317 | 324 | +7 |
| O3 | 324 | 328 | +4 |

Final: **328 pass / 0 fail** in `src/team/ src/tool/`.

### Open follow-ups / observations

- O1: failover swap assumes fallback uses a *different* provider so the per-team breaker reset is safe. If both primary and fallback share a provider, the breaker reset could prematurely re-charge a still-rate-limited provider. Document expected setup: pin agents to distinct providers for failover to make sense.
- O2: plugins receive ALL bus events via the `event` hook, including team events. There is no per-event-type subscription filter — plugins must filter by `type` themselves. Acceptable but a future enhancement could provide typed subscriptions.
- O3: per-session sharing means N+1 share API calls. If/when `SessionShare` exposes a batch API, refactor `team_share` to use it.
- O4: no automatic resume on daemon restart. User must explicitly call `/team-resume`. Future could add `OPENCODE_AUTO_RESUME_TEAMS=1` env flag for ops-friendly behavior.

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
