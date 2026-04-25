# Team Behavior/Correctness Sweep — Design

**Date**: 2026-04-25
**Branch**: `spike/team-daemon`
**Scope**: Backlog items B1, B2, B4, B5 from `docs/team-improvements-backlog.md` (B3 deferred — see below)
**Sequence**: B5 → B1 → B4 → B2

## Context

Architecture sweep (A1-A5) complete. Worktree-per-engineer, subprocess isolation, task DAG, scoped heartbeat, nested running map all landed. Next sweep targets behavior/correctness gaps surfaced by deep-dive review on `spike/team-daemon`.

Key shift from A1: with worktree-per-engineer, runtime enforcement of `fileScope` becomes redundant. Worktree is the physical scope boundary. `fileScope` retained as **planning artifact** (decomposition validation, intent documentation) — not runtime guard.

## B3 deferral

B3 (retry transient LLM failures) targeted wrapping `promptService.loop` in `Effect.retry`. After spec review, this is the wrong abstraction layer: `promptService.loop` is a multi-turn conversation loop. Retrying it replays all prior turns — costly (token bomb) and changes user-visible state ordering. The correct retry layer is inside `session/llm.ts` at per-API-call granularity, where idempotent retry is safe. That refactor is out of this sweep's scope.

Item moved back to backlog with revised note.

---

## B5 — Mailbox TTL + purge verification

**Problem**: Mailbox messages have no TTL. Killed-engineer inboxes linger in DB.

**Audit results (during spec review)**:
- `SessionCoordinator.killEngineer` already calls `mailbox.purge(slot.sessionID)` at `src/team/session-coordinator.ts:311`.
- `SessionCoordinator.dissolveTeam` already calls `mailbox.purge(row.session_id)` at `src/team/session-coordinator.ts:377`.
- Both wired correctly. **No new wiring needed.**
- Goal becomes: regression-proof these calls + add age-based GC for messages that escape both paths (e.g., orphan rows from crashes).

**Design**:
- Add regression test in `src/team/lifecycle-integration.test.ts` (existing file): kill engineer → assert mailbox empty for that engineer; dissolve team → assert mailbox empty for all engineers.
- Add `mailbox.purgeOlderThan(maxAgeMs): Effect<number, DbError>` returning purged count. Predicate on `created_at` (mailbox column name per `src/team/mailbox.sql.ts:36`; messages should not survive 24h regardless of read state — TTL is for orphan cleanup, not unread management). Note: `task_board` uses `time_created` via the shared `Timestamps` spread, but mailbox has its own column.
- Add daemon sweep: on each `HEARTBEAT_CHECK_INTERVAL` tick (60s), purge messages older than `MAILBOX_MAX_AGE_MS = 86_400_000` (24h). Rationale: 24h covers a typical workday; orphan rows past that point are noise. Configurability deferred until evidence we need it.
- New constant in `src/team/constants.ts`.

**Files**:
- `src/team/constants.ts` — add `MAILBOX_MAX_AGE_MS`
- `src/team/mailbox.ts` — add `purgeOlderThan` method (+ test in `mailbox.test.ts` if it exists; otherwise add to `lifecycle-integration.test.ts`)
- `src/team/daemon.ts` — call `purgeOlderThan` from heartbeat sweep
- `src/team/lifecycle-integration.test.ts` — regression test for kill/dissolve purge wiring + age-based GC test

---

## B1 — fileScope overlap validation in `team_decompose`

**Problem**: Lead can submit overlapping `fileScope` arrays; no validation. Worktree-per-engineer prevents physical conflicts but engineers will produce duplicate work and merge conflicts at squash time.

**Design**:
- Reject hard. Lead must produce disjoint scopes. No `force` flag.
- Validation lives in `LeadCoordinator.decompose`. Tool layer (`TeamDecomposeTool`) thin pass-through.
- `GitManager.detectOverlap(a: string[], b: string[]) => Effect<boolean, never>` is **pairwise**. No new API. `decompose` runs O(n²) pairwise loop in Effect.gen, collecting all overlapping pairs (3+ engineers → return all pairs, not fail-fast — Lead gets full picture in one shot).
- Error: tagged `OverlappingScopesError` (new class in `src/team/errors.ts`) with payload `pairs: ReadonlyArray<{a: string, b: string, overlap: ReadonlyArray<string>}>` where `a`/`b` are engineer-task labels (engineers don't exist yet at decompose time — use task title/index) and `overlap` is the intersecting glob list (from `picomatch.intersect` if available; else just the raw scopes that triggered the match).
- Error message format (deterministic for LLM Lead consumption): `Overlapping fileScopes detected. Re-decompose with disjoint scopes:\n  - Task "X" and Task "Y": [scope1, scope2]\n  - ...`

**Edge cases**:
- Empty scope arrays — skip pair (no overlap possible).
- Single-task decompose — no pairs, pass.
- Self-comparison — skipped by loop bounds.

**Files**:
- `src/team/lead-coordinator.ts` — pairwise loop wired into `decompose`
- `src/team/errors.ts` — new `OverlappingScopesError` (Schema.TaggedErrorClass)
- `src/tool/team.ts` — surface formatted error message in `TeamDecomposeTool` output
- `src/team/lead-coordinator.test.ts` — test cases: exact match, glob expansion, nested prefix, empty scope, single task, 3+ engineers all overlapping

---

## B4 — Audit trail at dissolve

**Problem**: `team_dissolve` hard-deletes task board. No history of completed work.

**Migration infrastructure (audit results)**:
- `drizzle.config.ts` exists, dialect=sqlite, output=`./migration/`.
- 14 prior migrations in `migration/` (latest: `20260424000000_task_dependencies`).
- Workflow: edit `*.sql.ts` schema file → `bunx drizzle-kit generate` → commit generated SQL.

**Schema reality**: there is **one** task table — `task_board` — defined in `src/team/task-board.sql.ts`. No separate `tasks` table. Earlier draft conflated colloquial "tasks" with the table name.

**Design**:
- Soft-delete via `archived_at INTEGER` (epoch ms, nullable) column on `task_board` table.
- `dissolveTeam` replaces the per-task delete loop with single bulk `UPDATE task_board SET archived_at = ? WHERE team_id = ?`. N round-trips → 1.
- `TaskBoardRepo.delete(taskId)` method: keep for admin/test paths; not used by `dissolveTeam` anymore.
- All read predicates add `AND archived_at IS NULL`.

**Read-path enumeration (every SELECT must include `archived_at IS NULL`; the read inside `update` must include it as well so archived rows are not silently mutated)**:

| # | Method | File:line | Notes |
|---|--------|-----------|-------|
| 1 | `update` (read-then-write existence check) | `src/team/task-board.ts:110` | If skipped, archived rows can be re-mutated |
| 2 | `list` (filter-based query) | `src/team/task-board.ts:143` | Consumer: `session-coordinator.ts:386` `taskBoard.list({ team_id })` — covered by repo-layer filter |
| 3 | `get` (single-id fetch) | `src/team/task-board.ts:149` | |
| 4 | `listReadyTasks` (DAG dispatch — assigns work to engineers) | `src/team/task-board.ts:156` | **Critical**: missing this filter would re-surface archived tasks for claim |

New read path: `TaskBoardRepo.listArchived(teamID)` returning archived rows for future `team_history` consumption.

**Migration**:
- Edit `src/team/task-board.sql.ts` to add `archived_at: integer()` (nullable) to `TaskBoardTable`.
- Run `bunx drizzle-kit generate` to produce the new migration file in `migration/`.
- Existing rows default `NULL` (active). No data backfill.

**Files**:
- `src/team/task-board.sql.ts` — add `archived_at` column
- `src/team/task-board.ts` — add `archived_at IS NULL` predicate to all 4 SELECTs (incl. `update`'s pre-write check); new `listArchived` repo method; new `archiveTeamBoard(teamID)` bulk update method
- `src/team/session-coordinator.ts` — `dissolveTeam` (~line 386-395) calls `archiveTeamBoard` instead of per-task delete loop
- `migration/<timestamp>_task_archive.sql` — drizzle-kit generated
- `src/team/task-board-service.test.ts` — test soft-delete + filtering on all 4 reads + `listArchived` + `listReadyTasks` excludes archived

---

## B2 — Remove PermissionGuard for engineers

**Problem (reframed)**: PermissionGuard runtime enforcement was the only safety net under shared-tree. Worktree-per-engineer (A1) replaces it with physical isolation. Engineers = Lead permissions. PermissionGuard is now dead weight.

**Audit results**:
- `src/session/prompt.ts` has 3 guard sites: lines 420 (native tool), 465 (MCP tool), 591 (TaskTool).
- All 3 use `Effect.serviceOption(PermissionGuard.Service)` (optional injection).
- `PermissionGuard` service is consumed only by these 3 sites + tests.
- `fileScope` field on engineers remains (planning artifact for B1, surfaced in monitor/roster output).

**Design — full deletion**:
1. Remove all 3 `enforceForTool` calls from `src/session/prompt.ts`.
2. Drop `PermissionGuard` import + `serviceOption` lookups from `src/session/prompt.ts`.
3. Delete `src/team/permission-guard.ts`.
4. Delete `src/team/permission-guard.test.ts`.
5. Drop `permissionGuardLayer` from `src/effect/app-runtime.ts` AppLayer composition.
6. Remove guard fixtures from any test that mocks/provides the service. Suspected sites (verify via grep before edit):
   - `src/team/lifecycle-integration.test.ts`
   - `src/team/final-qa-lifecycle.test.ts`
7. Run `bun test src/team/ src/tool/ src/session/` — must stay green.
8. Run `bunx tsc --noEmit` — no orphaned references.

**fileScope serialization audit**:
- `EngineerSlot` schema must keep `fileScope` field — used by B1 validation + display.
- `team_monitor` / `team_roster` tool outputs must continue rendering it. Verify after B2 lands.

**Files**:
- `src/session/prompt.ts` — remove 3 guard calls
- `src/team/permission-guard.ts` — delete
- `src/team/permission-guard.test.ts` — delete
- `src/effect/app-runtime.ts` — drop layer
- `src/team/lifecycle-integration.test.ts` — clean fixtures (per audit)
- `src/team/final-qa-lifecycle.test.ts` — clean fixtures (per audit)

---

## Cross-cutting

- All items follow established **subagent-driven-development** workflow: implementer → spec compliance review → code quality review → fix → re-review → commit per item.
- Tests must pass at every item boundary. `bun test src/team/ src/tool/` must stay green.
- Each item lands as its own commit. Suggested message style:
  - B5: `feat(team): mailbox TTL + purge regression tests (B5)`
  - B1: `feat(team): reject overlapping fileScopes in decompose (B1)`
  - B4: `feat(team): soft-delete task board on dissolve (B4)`
  - B2: `refactor(team): remove PermissionGuard (worktree supersedes) (B2)`
- Use `bunx tsc --noEmit` filter from `team-improvements-backlog.md` recovery context after each item to gate on type errors.

## Effect-ts v4 retry note (deferred B3, kept here for future reference)

When B3 is picked up at the right layer (inside `session/llm.ts`), the canonical Effect v4 pattern is:
```ts
Effect.retry(effect, {
  schedule: Schedule.exponential("1 second").pipe(
    Schedule.jittered,
    Schedule.intersect(Schedule.recurs(1)),
  ),
  while: (err) => isTransientError(err),
})
```
`Schedule.recurs(1)` means "1 retry after the first attempt" → 2 total tries. Verify via test: mock 5xx-then-success → assert exactly 2 attempts. Pin signature against `node_modules/.bun/effect@4.0.0-beta.48/`.

## Out of scope

- B1 `force` flag (rejected by design).
- B3 retry — deferred to a future sweep that touches `session/llm.ts`.
- B4 `team_history` LLM tool — defer; data persisted, tool added when surface need is clear.
- B5 daemon-level GC of old archived rows (defer until B4 retention review surfaces a need).
- A6+, U*, E*, S*, O* items — out of this sweep.
