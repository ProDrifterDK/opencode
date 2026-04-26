# Team Spike — tsc Cleanup Plan

> Generated 2026-04-25 after full backlog sweep complete (A1-A5, B1/B2/B4/B5, U1-U6, E1-E4, S1-S3, O1-O4).
> Branch: `spike/team-daemon`. Latest commit: `5ac1075e2` (`fix(team): correct @/server import path in team-engineer.ts`).
> Document survives context compaction — work resumes from here.

## Why this exists

`turbo run typecheck` (pre-push hook on this repo) fails on **157 tsc errors**. Push to fork blocked. User decision: tackle the full 157 cleanups (not `--no-verify` skip).

## Error origin breakdown

| Snapshot | tsc errors | Source |
|---|---|---|
| `b0455583a` (fork point from `origin/dev`) | **4** | upstream baseline |
| `b008eb334` (start of this session — A1-A5 + B1/B2/B4/B5 already landed) | **152** | spike technical debt from prior sessions (architecture + behavior sweeps) |
| `5ac1075e2` (HEAD now — after U/E/S/O sweeps) | **157** | +5 from this session's UX/Efficiency/Security/OpenCode-native sweeps |

**~96% of the 157 errors are spike technical debt, NOT upstream issues.** All 157 must be fixed before this branch can be cleanly merged upstream OR pushed without `--no-verify`.

## Working dir for all commands

`/home/prodrifterdk/Documentos/projects/opencode/packages/opencode`

## Errors by file (full list, sorted by count)

| Errors | File | Owned by spike? |
|---|---|---|
| 52 | `src/tool/team.ts` | ✅ yes (team feature) |
| 11 | `src/effect/app-runtime.ts` | ⚠️ touched by spike (added team layers) |
| 9 | `src/session/prompt.ts` | ⚠️ touched by spike (PermissionGuard sites — now removed) |
| 8 | `src/team/task-board-service.ts` | ✅ yes |
| 7 | `src/team/lead-coordinator.ts` | ✅ yes |
| 6 | `src/team/message-summarizer.ts` | ✅ yes |
| 6 | `src/team/daemon.ts` | ✅ yes |
| 5 | `src/team/lifecycle-integration.test.ts` | ✅ yes |
| 5 | `src/team/final-qa-lifecycle.test.ts` | ✅ yes |
| 5 | `src/cli/cmd/providers.ts` | ❌ pre-existing (1 of 4 baseline) |
| 4 | `src/team/heartbeat.test.ts` | ✅ yes |
| 3 | `test/config/tui.test.ts` | ❌ pre-existing |
| 3 | `src/cli/cmd/agent.ts` | ❌ pre-existing |
| 2 | `test/tool/task.test.ts` | ⚠️ may be touched by spike |
| 2 | `test/tool/skill.test.ts` | ⚠️ may be touched by spike |
| 2 | `test/tool/registry.test.ts` | ⚠️ may be touched by spike |
| 2 | `test/session/structured-output-integration.test.ts` | ❌ pre-existing |
| 2 | `test/session/snapshot-tool-race.test.ts` | ❌ pre-existing |
| 2 | `test/session/prompt.test.ts` | ❌ pre-existing |
| 2 | `src/tool/registry.ts` | ❌ pre-existing |
| 2 | `src/cli/cmd/debug/agent.ts` | ❌ pre-existing |
| 2 | `src/account/repo.ts` | ❌ pre-existing |
| 1 | `test/provider/provider.test.ts` | ❌ pre-existing |
| 1 | `test/lib/llm-server.ts` | ❌ pre-existing |
| 1 | `test/config/engineer-agent.test.ts` | ❌ pre-existing |
| 1 | `src/tool/plan.ts` | ❌ pre-existing |
| 1 | `src/team/task-dag.test.ts` | ✅ yes |
| 1 | `src/team/rate-limiter.ts` | ✅ yes |
| 1 | `src/team/message-summarizer.test.ts` | ✅ yes |
| 1 | `src/team/mailbox.ts` | ✅ yes |
| 1 | `src/team/lead-coordinator.test.ts` | ✅ yes |
| 1 | `src/team/engineer-loop.ts` | ✅ yes |
| 1 | `src/server/routes/instance/session.ts` | ❌ pre-existing |
| 1 | `src/server/routes/instance/experimental.ts` | ❌ pre-existing |
| 1 | `src/cli/cmd/upgrade.ts` | ❌ pre-existing |
| 1 | `src/cli/cmd/pr.ts` | ❌ pre-existing |
| 1 | `src/cli/cmd/github.ts` | ❌ pre-existing |
| **157** | **TOTAL** | |

## Errors by TS code

| Count | Code | Pattern | Notes |
|---|---|---|---|
| 41 | TS2345 | Argument not assignable | Mostly Effect Layer/Context mismatches in tools + tests |
| 30 | TS1 | Effect lint custom | `missingEffectError`, `missingEffectContext` — Tool.define API expects specific Init shapes |
| 23 | TS7006 | Implicit any parameter | Pre-existing scattered across pre-existing files + a few new in test mocks |
| 18 | TS7 | Effect lint custom | Various Effect v3→v4 idioms |
| 8 | TS2322 | Type not assignable | Mostly `Brand<T>` mismatches + EngineerSlot shape drift |
| 5 | TS38 | Effect lint custom | Layer-related |
| 5 | TS2741 | Property missing | **Almost certainly all `archived_at` from B4** (Task fixtures lack the field) |
| 4 | TS7022 | Implicit any from circular reference | `app-runtime.ts` AppLayer/Runtime type recursion |
| 4 | TS2304 | Cannot find name | Likely missing imports |
| 3 | TS2339 | Property does not exist | Likely Effect API drift |
| 2 | TS7024 | Function implicit return any | `app-runtime.ts` |
| 2 | TS54 | Effect lint custom | `effectFnImplicitAny` |
| 2 | TS3 | Effect lint custom | |
| 2 | TS2488 | Iterator/iterable | |
| 2 | TS18046 | `unknown` type | |

## Categorized remediation strategy

### Category A — Mock interface widening (HIGH PRIORITY, easy wins, ~6 errors)

**Files**: `team/lifecycle-integration.test.ts`, `team/final-qa-lifecycle.test.ts`, `team/heartbeat.test.ts`

**Pattern**: Test mocks for `LeadCoordinator` / `SessionCoordinator` / `TaskBoardRepo` / `MailboxService` were widened by various sweeps (B4 added `archiveTeamBoard`/`listArchived`, U6 added `retask`, O4 added `resumeTeam`, O1 added `fallbackAgent` field on `EngineerSlot`, S1 added send signature). Some sweep agents updated their direct test mocks; sibling test files lagged.

**Fix per error**:
- `Task` fixture missing `archived_at: null` → add the field (5 errors of TS2741)
- `EngineerSlot` fixture missing `fallbackAgent` field → add `fallbackAgent: null` (TS2322 in `heartbeat.test.ts:18`, `lifecycle-integration.test.ts:52`, etc.)
- `LeadCoordinator` mock missing `retask` method stub → add `retask: () => Effect.fail(new Error("not impl in test"))` (TS2345 mock-shape errors)
- `SessionCoordinator` mock missing `resumeTeam` method → already added in O4 to lifecycle-integration but missing in `heartbeat.test.ts` and `final-qa-lifecycle.test.ts`
- `TaskBoardRepo` mock missing `archiveTeamBoard` / `listArchived` → already added in B4 to most files but check remaining

**Estimated effort**: 30-45 minutes. Mechanical.

### Category B — Effect Tool.define inference debt (HIGH IMPACT, ~52 + ~30 = 82 errors)

**Files**: `src/tool/team.ts` (52 errors), all are `TS1` lint + `TS2345`

**Pattern**: `Tool.define(...)` API expects a specific `Init<Z, R>` Effect shape. Each tool definition reports:
- `missingEffectError` (e.g., expected `Error` in errors channel)
- `missingEffectContext` (e.g., expected `unknown` in context channel)
- `TS2345` mismatch on the outer `Tool.define(name, effect)` argument

**Root cause**: Effect-ts v4 beta API drift. Tools were authored against v3-style `Tool.define`. The v4 lint expects:
```ts
Tool.define("name", Effect.gen(...) as Effect<Tool.Init<Schema, Output>, never, Service>)
```
where `Tool.Init` carries the specific schema/output types and the error channel is `never` (or contains only Tool errors).

**Two paths**:
- **(a)** Wrap each `Effect.gen(...)` body with `as Effect<Tool.Init<...>, never, ...>` annotation — safe but verbose, mostly type assertions
- **(b)** Refactor all 17 (now 20) tools to use a typed factory that infers the Init shape from the schema — ~3 hours, risky if Tool API changes again

Recommend (a). Per-tool annotation. ~5min each × 20 tools = ~100min.

**Estimated effort**: ~2 hours.

### Category C — Layer.mergeAll inference (~11 errors in `app-runtime.ts`)

**File**: `src/effect/app-runtime.ts`

**Pattern**: 
- `TS7022 'AppLayer' implicitly has type 'any'` (circular reference)
- `TS2456 Type alias 'Runtime' circularly references itself`
- `TS37` (warning) `layerMergeAllWithDependencies` — Layer X provides Service required by Layer Y in same `Layer.mergeAll` (parallel composition issue)

**Root cause**: `AppLayer = Layer.mergeAll(layerA, layerB, layerC, ...)` where some layers depend on others. Effect v4 requires `Layer.provideMerge` for ordered composition, not `Layer.mergeAll` (parallel).

**Fix**: Refactor `AppLayer` composition to use explicit dependency chains:
```ts
const baseLayer = Layer.mergeAll(<no-deps layers>)
const middleLayer = Layer.provideMerge(<dep-on-base layers>, baseLayer)
const AppLayer = Layer.provideMerge(<dep-on-middle layers>, middleLayer)
```

Plus annotate `AppLayer` and `AppRuntime` with explicit types:
```ts
export const AppLayer: Layer.Layer<ServiceA | ServiceB | ..., never, never> = ...
export type AppRuntime = Runtime.Runtime<ServiceA | ServiceB | ...>
```

**Estimated effort**: ~1 hour. Surgical layer refactor.

### Category D — Effect v3→v4 lint suggestions (~30 errors of TS1, TS7, TS44, TS47, TS54)

**Files**: scattered across `src/team/`, `src/auth/`, `src/config/`

**Patterns**:
- `effect(unnecessaryFailYieldableError)` — `Effect.fail(taggedError)` should be `yield* taggedError`
- `effect(tryCatchInEffectGen)` — `try/catch` inside `Effect.gen` should use `Effect.try` / `Effect.catch`
- `effect(preferSchemaOverJson)` — `JSON.parse/stringify` should use `Schema.parseJson` (mostly noise, low value)
- `effect(effectSucceedWithVoid)` — `Effect.succeed(undefined)` → `Effect.void`
- `effect(effectFnImplicitAny)` — `Effect.fn` parameter needs explicit type

**Fix**: Mechanical, one-liners each. Most are spike-owned files (`team/`, `tool/`).

**Estimated effort**: ~1 hour. ~3min per error × 30 = 90min.

### Category E — Pre-existing pre-spike noise (~30 errors)

**Files**: `src/account/repo.ts`, `src/cli/cmd/agent.ts`, `src/cli/cmd/github.ts`, `src/cli/cmd/providers.ts`, `src/cli/cmd/pr.ts`, `src/cli/cmd/upgrade.ts`, `src/cli/cmd/debug/agent.ts`, `src/server/routes/instance/*.ts`, `src/tool/plan.ts`, `src/tool/registry.ts`, `test/config/*.ts`, `test/provider/provider.test.ts`, `test/session/*.ts`, `test/lib/llm-server.ts`

**Pattern**: TS7006 implicit-any parameters mostly. Pre-existing in upstream. NOT introduced by spike.

**Decision**: Fix anyway since user wants 0 errors. Most are 1-line type annotations on lambda params. Should batch-fix mechanically.

**Estimated effort**: ~30-45 minutes.

## Total estimated effort

~5-6 hours of focused work. Categories A → C → B → D → E. A first because mechanical and unblocks confidence; C next because it's a single file refactor that may cascade-fix others; B is the biggest category but mostly type annotations; D + E are mechanical batch fixes.

## Sequence + dispatch plan

After context compact:

1. **Category A (mock widening)** — single executor agent, sonnet, ~30min.
2. **Category C (app-runtime.ts layer refactor)** — single executor agent, opus (architecture work), ~1h.
3. **Category B (Tool.define annotations)** — single executor agent, sonnet, ~2h.
4. **Category D (Effect v3→v4 lint)** — single executor agent, sonnet, ~1h.
5. **Category E (pre-existing noise)** — single executor agent, sonnet, ~45min.
6. After all 5: re-run `bunx tsc --noEmit` — must be 0 errors. Run `bunx turbo run typecheck` — must pass. Then push.

Each agent commits their batch. Total ~5-6 commits.

## Pre-cleanup test count

`bun test src/team/ src/tool/` → **330 pass / 0 fail** at HEAD `5ac1075e2`.

Test count must NOT regress through cleanup. After each category: run full suite, expect ≥330.

## Final state at HEAD `5ac1075e2`

### Backlog status

| Category | Status |
|---|---|
| A1-A5 Architecture | ✅ |
| B1, B2, B4, B5 Behavior | ✅ |
| B3 | ⏸ deferred (`session/llm.ts` per-call refactor) |
| U1-U6 UX/UI | ✅ |
| E1-E4 Efficiency | ✅ |
| S1-S3 Security | ✅ |
| O1-O4 OpenCode-native | ✅ |
| Worktree cleanup follow-up | ✅ |
| @/server import fix follow-up | ✅ |
| **tsc cleanup (this doc)** | ⏳ pending |

### Tool count

20 tools: team_create, team_spawn, team_decompose, team_assign, team_reassign, team_retask, team_kill, team_monitor, team_message, team_status, team_report, team_dissolve, team_resume, team_commit, team_inbox, team_roster, team_tasks, team_claim, team_agents, team_share

### Migrations

- `20260424000000_task_dependencies` (A4)
- `20260425175151_sudden_steel_serpent` (B4 — `task_board.archived_at`)
- `20260425180000_fallback_agent_column` (O1 — `engineer_slot.fallback_agent_name`)

### Commit log (this session, in chronological order)

```
b73036a86 feat(team): mailbox TTL + purge regression tests (B5)
d43b268e8 test(team): strengthen B5 mailbox purge regression coverage
fc06854ae refactor(team): B5 cleanup — Cause.pretty logging, drop dead cast, boundary test
cf461fd8b feat(team): reject overlapping fileScopes via glob check in decompose (B1)
462531c9f feat(team): soft-delete task board on dissolve via archived_at (B4)
6ffd0b38f refactor(team): remove PermissionGuard (worktree-per-engineer supersedes) (B2)
b008eb334 docs(team): mark B1/B2/B4/B5 done; B3 deferred
8d320a779 feat(team): derive engineer default name from task title (U3)
bac98a05f feat(team): split Lead prompt into core + reference appendix (U5)
e3ce6de0c feat(team): TUI engineer-row click navigates to engineer session (U2)
9c8488fc7 feat(team): structured markdown summary at team_dissolve (U1)
7282b5e1c feat(team): include rate-limit pressure in team_monitor output (U4)
32337be2e feat(team): add team_retask tool for interactive task replan (U6)
4fed3b4dd docs(team): mark U1-U6 done
84912ff6d docs(team): document dual-publish rationale in publishTeamEvent (E3)
a228e22ce feat(team): reconcile rate-limiter with actual token usage post-loop (E1)
111bde140 perf(team): cache team_agents result for 30s (E4)
02377749d feat(team): add optional complexity field on SubtaskSpec for routing hints (E2)
96f8925f8 docs(team): mark E1-E4 done
99ecbc331 feat(team): eager agentName validation in team_spawn (S3)
d24df0f96 feat(team): per-sender rate limit on team_message (10/min) (S1)
f64293ff1 feat(team): scope team_commit pathspec to active engineer fileScopes (S2)
e4287a35b docs(team): mark S1-S3 done; note S2 stale post-A1
1ae7a09f8 feat(team): fallbackAgent on team_spawn for circuit-breaker failover (O1)
bb12deb8c feat(team): expose team events through plugin trigger system (O2)
17c1dbc49 feat(team): /team-resume slash command + team_resume tool (O4)
cc915da9e feat(team): team_share tool for whole-team transcript share (O3)
1c12d4f60 docs(team): mark O1-O4 done
44dec919e fix(team): cleanup engineer worktrees on team_dissolve
5ac1075e2 fix(team): correct @/server import path in team-engineer.ts (O1 follow-up)
```

### Remote state

- `origin` = `https://github.com/sst/opencode.git` (read-only for ProDrifterDK)
- `fork` = `https://github.com/ProDrifterDK/opencode.git` (write access — ready to push once typecheck clean)
- Push attempt at HEAD `5ac1075e2` with default hooks: BLOCKED by pre-push `turbo run typecheck`.

## Push command (after cleanup completes)

```
cd /home/prodrifterdk/Documentos/projects/opencode
bunx tsc --noEmit  # must be 0 errors
git push -u fork spike/team-daemon
```

## Notes for post-compact resumption

- **Do NOT use `--no-verify`**. User explicitly chose to fix all 157.
- **Do NOT touch upstream `dev`** — branch will rebase/merge later, separate concern.
- **Commit per category** (5-6 commits) to make review easier.
- **Re-read this doc first** if resuming from compact — it's the source of truth on remediation strategy and current state.
