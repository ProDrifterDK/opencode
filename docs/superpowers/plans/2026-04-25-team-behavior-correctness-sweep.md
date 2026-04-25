# Team Behavior/Correctness Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land items B5, B1, B4, B2 from `docs/team-improvements-backlog.md` — mailbox TTL/GC, fileScope overlap rejection (glob-aware), task-board soft-delete on dissolve, removal of PermissionGuard now that worktree-per-engineer supersedes it.

**Architecture:** Each B item is its own commit. TDD per item: write failing test → implement → verify green → commit. Two-stage review per item (spec compliance → code quality) per established subagent-driven workflow.

**Tech Stack:** TypeScript, Effect-ts v4 beta, Drizzle ORM (SQLite), Bun runtime. Tests via `bun test`.

**Spec:** `docs/superpowers/specs/2026-04-25-team-behavior-correctness-sweep-design.md`

**Working directory for all commands:** `/home/prodrifterdk/Documentos/projects/opencode/packages/opencode`

**Sequence:** B5 → B1 → B4 → B2 (B3 deferred per spec).

---

## File Structure Map

| File | Modification | Tasks touching it |
|------|--------------|-------------------|
| `src/team/constants.ts` | Add `MAILBOX_MAX_AGE_MS` constant | B5 |
| `src/team/mailbox.ts` | Add `purgeOlderThan` method to service interface + impl | B5 |
| `src/team/daemon.ts` | Wire `purgeOlderThan` into `checkForStaleEngineers` (or sibling sweep) | B5 |
| `src/team/lifecycle-integration.test.ts` | Regression tests for kill/dissolve purge wiring + GC test | B5 |
| `src/team/git-manager.ts` | Export `globOverlap` helper for reuse | B1 |
| `src/team/lead-coordinator.ts` | Replace exact-match `filesOverlap` with glob-aware overlap detection; collect all pairs | B1 |
| `src/team/lead-coordinator.test.ts` | Tests for glob overlap rejection | B1 |
| `src/team/task-board.sql.ts` | Add `archived_at` column to `TaskBoardTable` | B4 |
| `migration/<new>.sql` | Drizzle-generated migration adding column | B4 |
| `src/team/task-board.ts` | Add `archived_at IS NULL` predicate to all 4 reads; add `listArchived` + `archiveTeamBoard` repo methods | B4 |
| `src/team/session-coordinator.ts` | Replace per-task `delete` loop in `dissolveTeam` with single `archiveTeamBoard` call | B4 |
| `src/team/task-board-service.test.ts` | Soft-delete + archived filter coverage | B4 |
| `src/session/prompt.ts` | Remove 3 `PermissionGuard.enforceForTool` call sites | B2 |
| `src/team/permission-guard.ts` | Delete | B2 |
| `src/team/permission-guard.test.ts` | Delete | B2 |
| `src/effect/app-runtime.ts` | Drop `permissionGuardLayer` from AppLayer | B2 |
| `src/team/lifecycle-integration.test.ts` | Strip `PermissionGuard` fixtures (audit grep before edit) | B2 |
| `src/team/final-qa-lifecycle.test.ts` | Strip `PermissionGuard` fixtures (audit grep before edit) | B2 |

---

## Task 1 (B5): Mailbox TTL + age-based GC

**Files:**
- Modify: `src/team/constants.ts`
- Modify: `src/team/mailbox.ts`
- Modify: `src/team/daemon.ts`
- Test: `src/team/lifecycle-integration.test.ts`

### Step 1: Read existing code (context-gathering)

Read these files to understand current structure:
- `src/team/mailbox.ts` (lines 40-90 for service interface + DB query patterns)
- `src/team/constants.ts` (full file — small)
- `src/team/daemon.ts` lines 414-430 (`checkForStaleEngineers`) and lines 770-790 (interval registration)
- `src/team/lifecycle-integration.test.ts` (look at existing kill/dissolve tests to find the right place to add regression coverage)

### Step 2: Add `MAILBOX_MAX_AGE_MS` constant

- [ ] Edit `src/team/constants.ts`. Add at end of the export block:

```ts
/** Mailbox messages older than this are GC'd by the daemon sweep. Orphan-cleanup TTL, not unread management. */
export const MAILBOX_MAX_AGE_MS = 86_400_000 // 24h
```

### Step 3: Write the failing test for `purgeOlderThan`

- [ ] Open `src/team/lifecycle-integration.test.ts`. Locate an existing `describe` block that touches mailbox (or add a new `describe("Mailbox GC", ...)` block at the end). Add this test:

```ts
it("purgeOlderThan removes messages older than threshold", async () => {
  const program = Effect.gen(function* () {
    const mailbox = yield* Mailbox.Service
    const recipient = "session_recipient_1" as SessionID
    const sender = "session_sender_1" as SessionID

    // Inject a message, then backdate created_at via direct DB write
    yield* mailbox.send({
      sender_session_id: sender,
      recipient_session_id: recipient,
      kind: "info",
      priority: "normal",
      payload: "old message",
    })

    // Backdate to 25h ago via the underlying DB
    const db = yield* Drizzle
    const cutoffMs = Date.now() - 25 * 60 * 60 * 1000
    db.update(MailboxTable).set({ created_at: cutoffMs }).run()

    // Add a fresh message that should survive
    yield* mailbox.send({
      sender_session_id: sender,
      recipient_session_id: recipient,
      kind: "info",
      priority: "normal",
      payload: "fresh message",
    })

    const purged = yield* mailbox.purgeOlderThan(86_400_000)
    expect(purged).toBe(1)

    const remaining = yield* mailbox.peek({ recipient_session_id: recipient, limit: 10 })
    expect(remaining.length).toBe(1)
    expect(remaining[0].payload).toBe("fresh message")
  })

  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})
```

(Adjust imports — `MailboxTable` from `./mailbox.sql`, `Drizzle` whatever the existing test setup uses; mirror the pattern of existing mailbox tests already in the file.)

### Step 4: Run test, expect failure

```bash
bun test src/team/lifecycle-integration.test.ts -t "purgeOlderThan"
```
Expected: FAIL — `mailbox.purgeOlderThan is not a function`.

### Step 5: Add `purgeOlderThan` to mailbox interface

- [ ] In `src/team/mailbox.ts`, add to the `Interface` (around line 50, near `purge`):

```ts
readonly purgeOlderThan: (maxAgeMs: number) => Effect.Effect<number, DbError>
```

### Step 6: Implement `purgeOlderThan`

- [ ] In `src/team/mailbox.ts`, after the existing `purge` implementation (around line 240-248), add:

```ts
const purgeOlderThan = Effect.fn("Mailbox.purgeOlderThan")(function* (maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs
  return yield* Effect.try({
    try: () => {
      const result = db.delete(MailboxTable).where(lt(MailboxTable.created_at, cutoff)).run()
      return result.changes ?? 0
    },
    catch: (cause) => new DbError({ message: "purgeOlderThan failed", cause }),
  })
})
```

Then update the returned `Service.of(...)` to include the new method:
```ts
return Service.of({ send, receive, receiveByPriority, peek, markRead, purge, purgeOlderThan, hasUnread })
```

Add `lt` to the drizzle imports at the top: `import { eq, and, asc, desc, lt } from "drizzle-orm"` (preserve other existing imports).

### Step 7: Run test, expect pass

```bash
bun test src/team/lifecycle-integration.test.ts -t "purgeOlderThan"
```
Expected: PASS.

### Step 8: Wire into daemon heartbeat sweep

- [ ] In `src/team/daemon.ts`, after the existing `checkForStaleEngineers` function ends (around line 460+; find by `const checkForStaleEngineers = () => {`), add a sibling sweep function:

```ts
const purgeStaleMailboxMessages = () => {
  Effect.runFork(
    mailbox.purgeOlderThan(MAILBOX_MAX_AGE_MS).pipe(
      Effect.tap((count) =>
        count > 0
          ? Effect.logInfo(`mailbox GC purged ${count} old messages`)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("mailbox GC failed", cause),
      ),
    ),
  )
}
```

Add `MAILBOX_MAX_AGE_MS` to the import from `./constants`.

### Step 9: Register the sweep in the heartbeat interval

- [ ] In `src/team/daemon.ts` around line 777, find:
```ts
heartbeatCheckInterval = setInterval(checkForStaleEngineers, HEARTBEAT_CHECK_INTERVAL)
```
Replace with:
```ts
heartbeatCheckInterval = setInterval(() => {
  checkForStaleEngineers()
  purgeStaleMailboxMessages()
}, HEARTBEAT_CHECK_INTERVAL)
```

### Step 10: Add regression test for kill purge wiring

- [ ] In `src/team/lifecycle-integration.test.ts`, add (or extend an existing kill test):

```ts
it("killEngineer purges that engineer's mailbox", async () => {
  // ... existing setup spawning + assigning engineer ...
  // send a message to the engineer
  yield* mailbox.send({
    sender_session_id: leadSessionID,
    recipient_session_id: engineer.sessionID,
    kind: "info",
    priority: "normal",
    payload: "test",
  })

  yield* coordinator.killEngineer({ teamID, engineerID: engineer.id })

  const remaining = yield* mailbox.peek({ recipient_session_id: engineer.sessionID, limit: 10 })
  expect(remaining.length).toBe(0)
})
```

(Mirror existing test setup — there is already a `lifecycle-integration.test.ts` in the file structure, follow its conventions.)

### Step 11: Add regression test for dissolve purge wiring

- [ ] Same file, add:

```ts
it("dissolveTeam purges all engineers' mailboxes", async () => {
  // setup team + 2 engineers, send messages to each
  // ...
  yield* coordinator.dissolveTeam({ teamID })
  const r1 = yield* mailbox.peek({ recipient_session_id: e1.sessionID, limit: 10 })
  const r2 = yield* mailbox.peek({ recipient_session_id: e2.sessionID, limit: 10 })
  expect(r1.length).toBe(0)
  expect(r2.length).toBe(0)
})
```

### Step 12: Run full team test suite, expect green

```bash
bun test src/team/ src/tool/
```
Expected: all pass (count was 246 after A3; should now be 246+ depending on how many tests you added — 3+).

### Step 13: TypeScript clean

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool)/" | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```
Expected: empty output (no new errors). If any, fix before commit.

### Step 14: Commit

```bash
git add src/team/constants.ts src/team/mailbox.ts src/team/daemon.ts src/team/lifecycle-integration.test.ts
git commit -m "feat(team): mailbox TTL + purge regression tests (B5)"
```

---

## Task 2 (B1): glob-aware fileScope overlap rejection

**Files:**
- Modify: `src/team/git-manager.ts` (export `globOverlap`)
- Modify: `src/team/lead-coordinator.ts` (replace exact-match `filesOverlap` with glob check; collect all pairs)
- Test: `src/team/lead-coordinator.test.ts`

### Step 1: Read existing code

- `src/team/git-manager.ts` lines 100-140 (`globOverlap` private helper + `detectOverlap`)
- `src/team/lead-coordinator.ts` lines 80-200 (`filesOverlap`, `decompose`, existing `FileScopeConflictError`)
- `src/team/lead-coordinator.test.ts` (find the existing `decompose` test block)

**Important context:** B1 is partially implemented today. `decompose` already runs an exact-match overlap check via `filesOverlap` (line 80-81: `a.filter((f) => b.includes(f))`). This catches `["src/auth/file.ts"]` vs `["src/auth/file.ts"]` but **NOT** `["src/**"]` vs `["src/auth/**"]`. Glob expansion is what's missing. Reuse existing `FileScopeConflictError` (don't add a new error class).

### Step 2: Export `globOverlap` from git-manager

- [ ] In `src/team/git-manager.ts` line 106, change:
```ts
const globOverlap = (a: string, b: string): boolean => {
```
to:
```ts
export const globOverlap = (a: string, b: string): boolean => {
```

### Step 3: Write failing test — glob overlap rejection

- [ ] In `src/team/lead-coordinator.test.ts`, find the existing `describe` block for `decompose`. Add:

```ts
it("rejects fileScopes overlapping via globs (e.g. src/** vs src/auth/**)", async () => {
  const program = Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const result = yield* Effect.either(
      lead.decompose({
        teamId: "team_t1" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: ["src/**"] },
          { id: "b", title: "B", description: "", files: ["src/auth/**"] },
        ],
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("FileScopeConflictError")
    }
  })
  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})

it("collects all overlapping pairs when 3+ subtasks overlap", async () => {
  const program = Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const result = yield* Effect.either(
      lead.decompose({
        teamId: "team_t2" as TeamID,
        request: "test",
        subtasks: [
          { id: "a", title: "A", description: "", files: ["src/**"] },
          { id: "b", title: "B", description: "", files: ["src/auth/**"] },
          { id: "c", title: "C", description: "", files: ["src/billing/**"] },
        ],
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("FileScopeConflictError")
      // Two pairs overlap: A↔B and A↔C. Message must mention both.
      const msg = (result.left as { message: string }).message
      expect(msg).toContain("A")
      expect(msg).toContain("B")
      expect(msg).toContain("C")
    }
  })
  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})

it("accepts disjoint glob fileScopes", async () => {
  const program = Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const tasks = yield* lead.decompose({
      teamId: "team_t3" as TeamID,
      request: "test",
      subtasks: [
        { id: "a", title: "A", description: "", files: ["src/auth/**"] },
        { id: "b", title: "B", description: "", files: ["src/billing/**"] },
      ],
    })
    expect(tasks.length).toBe(2)
  })
  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})

it("accepts single-task decompose with no pairs to compare", async () => {
  const program = Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const tasks = yield* lead.decompose({
      teamId: "team_t4" as TeamID,
      request: "test",
      subtasks: [
        { id: "a", title: "Solo", description: "", files: ["src/**"] },
      ],
    })
    expect(tasks.length).toBe(1)
  })
  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})

it("treats empty fileScope arrays as non-overlapping", async () => {
  const program = Effect.gen(function* () {
    const lead = yield* LeadCoordinator.Service
    const tasks = yield* lead.decompose({
      teamId: "team_t5" as TeamID,
      request: "test",
      subtasks: [
        { id: "a", title: "A", description: "", files: [] },
        { id: "b", title: "B", description: "", files: [] },
      ],
    })
    expect(tasks.length).toBe(2)
  })
  await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
})
```

(Mirror existing test imports — `LeadCoordinator`, `TeamID`, `Either` — from existing test file's top.)

### Step 4: Run tests, expect failures

```bash
bun test src/team/lead-coordinator.test.ts -t "fileScope" --bail
```
Expected: the glob-overlap and 3-way tests FAIL (current `filesOverlap` is exact-match). The disjoint/single/empty tests should PASS without any code change.

### Step 5: Replace `filesOverlap` with glob-aware multi-pair check

- [ ] In `src/team/lead-coordinator.ts` line 1, add to imports:
```ts
import { globOverlap } from "./git-manager"
```

- [ ] Delete the old `filesOverlap` helper at lines 80-81 entirely.

- [ ] Replace the file scope conflict block at lines 184-195 with a pairwise glob check that collects all conflicting pairs:

```ts
// ── File scope overlap check (glob-aware, all-pairs) ──────────────
const overlaps: Array<{ a: string; b: string; aFiles: string[]; bFiles: string[] }> = []
for (let i = 0; i < specs.length; i++) {
  for (let j = i + 1; j < specs.length; j++) {
    const a = specs[i]
    const b = specs[j]
    if (a.files.length === 0 || b.files.length === 0) continue
    const overlapping = a.files.some((af) => b.files.some((bf) => globOverlap(af, bf)))
    if (overlapping) {
      overlaps.push({
        a: a.id ?? a.title,
        b: b.id ?? b.title,
        aFiles: a.files,
        bFiles: b.files,
      })
    }
  }
}
if (overlaps.length > 0) {
  const lines = overlaps.map(
    (o) => `  - "${o.a}" vs "${o.b}": [${o.aFiles.join(", ")}] / [${o.bFiles.join(", ")}]`,
  )
  yield* new FileScopeConflictError({
    message: `Overlapping fileScopes detected. Re-decompose with disjoint scopes:\n${lines.join("\n")}`,
    conflictingFiles: overlaps.flatMap((o) => [...o.aFiles, ...o.bFiles]),
  })
}
```

### Step 6: Run tests, expect green

```bash
bun test src/team/lead-coordinator.test.ts
```
Expected: all PASS.

### Step 7: Run full team suite

```bash
bun test src/team/ src/tool/
```
Expected: all PASS. No regressions in other test files.

### Step 8: TypeScript clean

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool)/" | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```
Expected: empty.

### Step 9: Commit

```bash
git add src/team/git-manager.ts src/team/lead-coordinator.ts src/team/lead-coordinator.test.ts
git commit -m "feat(team): reject overlapping fileScopes via glob check in decompose (B1)"
```

---

## Task 3 (B4): soft-delete task board on dissolve

**Files:**
- Modify: `src/team/task-board.sql.ts` (add column)
- Generated: `migration/<timestamp>_*.sql` (drizzle-kit output)
- Modify: `src/team/task-board.ts` (4 read predicates + 2 new methods)
- Modify: `src/team/session-coordinator.ts` (`dissolveTeam` swap)
- Test: `src/team/task-board-service.test.ts`

### Step 1: Read existing code

- `src/team/task-board.sql.ts` (full file — small)
- `src/team/task-board.ts` lines 50-180 (interface + repo impl)
- `src/team/session-coordinator.ts` lines 380-410 (`dissolveTeam`)
- `src/team/task-board-service.test.ts` (existing test patterns)

### Step 2: Add `archived_at` column to schema

- [ ] In `src/team/task-board.sql.ts`, in the `TaskBoardTable` definition (around line 70-90), add inside the columns object after `completed_at`:

```ts
archived_at: integer(),
```

### Step 3: Generate migration

```bash
bunx drizzle-kit generate
```

Inspect the generated file under `migration/`. It should be a small `ALTER TABLE task_board ADD COLUMN archived_at INTEGER` (or equivalent). If drizzle-kit generates anything unexpected (table rebuild for SQLite), inspect carefully — SQLite migration generation can sometimes produce destructive operations. **If the generated migration drops or recreates `task_board`**, stop and consult the user.

### Step 4: Write failing tests

- [ ] In `src/team/task-board-service.test.ts`, add a new `describe("archived_at filtering", ...)` block:

```ts
describe("archived_at filtering", () => {
  it("get() returns null for archived tasks", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* TaskBoardRepo.Service
      const t = yield* repo.create({
        team_id: "team_arc1" as TeamID,
        title: "X",
        status: "pending",
      })
      yield* repo.archiveTeamBoard("team_arc1" as TeamID)
      const got = yield* repo.get(t.id)
      expect(got).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
  })

  it("list() excludes archived tasks", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* TaskBoardRepo.Service
      yield* repo.create({ team_id: "team_arc2" as TeamID, title: "X", status: "pending" })
      yield* repo.archiveTeamBoard("team_arc2" as TeamID)
      const tasks = yield* repo.list({ team_id: "team_arc2" as TeamID })
      expect(tasks.length).toBe(0)
    })
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
  })

  it("listReadyTasks() excludes archived tasks", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* TaskBoardRepo.Service
      yield* repo.create({ team_id: "team_arc3" as TeamID, title: "X", status: "pending" })
      yield* repo.archiveTeamBoard("team_arc3" as TeamID)
      const tasks = yield* repo.listReadyTasks("team_arc3" as TeamID)
      expect(tasks.length).toBe(0)
    })
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
  })

  it("update() refuses to mutate archived rows (returns error or no-op consistent with repo contract)", async () => {
    // Pick whichever behavior matches existing repo error contract.
    // Implementation must NOT silently mutate archived rows.
    const program = Effect.gen(function* () {
      const repo = yield* TaskBoardRepo.Service
      const t = yield* repo.create({ team_id: "team_arc4" as TeamID, title: "X", status: "pending" })
      yield* repo.archiveTeamBoard("team_arc4" as TeamID)
      const result = yield* Effect.either(repo.update(t.id, { title: "MUTATED" }))
      expect(Either.isLeft(result)).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
  })

  it("listArchived() returns archived rows for a team", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* TaskBoardRepo.Service
      const t = yield* repo.create({ team_id: "team_arc5" as TeamID, title: "X", status: "pending" })
      yield* repo.archiveTeamBoard("team_arc5" as TeamID)
      const archived = yield* repo.listArchived("team_arc5" as TeamID)
      expect(archived.length).toBe(1)
      expect(archived[0].id).toBe(t.id)
    })
    await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
  })
})
```

### Step 5: Run tests, expect failures

```bash
bun test src/team/task-board-service.test.ts -t "archived_at"
```
Expected: FAIL — `archiveTeamBoard`, `listArchived` not defined.

### Step 6: Add `archiveTeamBoard` and `listArchived` to repo interface

- [ ] In `src/team/task-board.ts` interface block (around line 50-65), add:

```ts
readonly archiveTeamBoard: (teamId: TeamID) => Effect.Effect<void, TaskBoardRepoError>
readonly listArchived: (teamId: TeamID) => Effect.Effect<Task[], TaskBoardRepoError>
```

### Step 7: Implement repo methods + add `archived_at IS NULL` filter to all 4 reads

- [ ] In `src/team/task-board.ts`, modify each existing read to add the predicate. Around line 110 (`update`'s pre-check):

Find:
```ts
const existing = db.select().from(TaskBoardTable).where(eq(TaskBoardTable.id, taskId)).get()
```
Replace with:
```ts
const existing = db
  .select()
  .from(TaskBoardTable)
  .where(and(eq(TaskBoardTable.id, taskId), isNull(TaskBoardTable.archived_at)))
  .get()
```

Repeat the same `and(..., isNull(TaskBoardTable.archived_at))` pattern at lines 143 (`list`), 149 (`get`), 156 (`listReadyTasks`).

Add `isNull` to drizzle imports at top of file: `import { eq, and, isNull } from "drizzle-orm"` (preserve existing imports).

- [ ] After the existing `delete: remove,` line in the returned `Service.of(...)`, add the two new method implementations above the return:

```ts
const archiveTeamBoard = Effect.fn("TaskBoardRepo.archiveTeamBoard")(function* (teamId: TeamID) {
  const now = Date.now()
  return yield* Effect.try({
    try: () => {
      db.update(TaskBoardTable)
        .set({ archived_at: now })
        .where(and(eq(TaskBoardTable.team_id, teamId), isNull(TaskBoardTable.archived_at)))
        .run()
    },
    catch: (cause) => new TaskBoardRepoError({ message: "archiveTeamBoard failed", cause }),
  })
})

const listArchived = Effect.fn("TaskBoardRepo.listArchived")(function* (teamId: TeamID) {
  return yield* Effect.try({
    try: () =>
      db
        .select()
        .from(TaskBoardTable)
        .where(and(eq(TaskBoardTable.team_id, teamId), isNotNull(TaskBoardTable.archived_at)))
        .all()
        .map(rowToTask),
    catch: (cause) => new TaskBoardRepoError({ message: "listArchived failed", cause }),
  })
})
```

Add `isNotNull` to drizzle imports.

Then update the returned object:
```ts
return Service.of({
  create,
  update,
  list,
  get: getById,
  delete: remove,
  listReadyTasks,
  archiveTeamBoard,
  listArchived,
})
```
(Adjust to match existing return-style in the file.)

### Step 8: Run tests, expect pass

```bash
bun test src/team/task-board-service.test.ts -t "archived_at"
```
Expected: all PASS.

### Step 9: Update `dissolveTeam` to use bulk archive

- [ ] In `src/team/session-coordinator.ts`, find the per-task delete loop around lines 386-395:

```ts
const allTasks = yield* taskBoard.list({ team_id: input.teamID }).pipe(
  Effect.catchAll(() => Effect.succeed([] as readonly Task[])),
)
yield* Effect.forEach(allTasks, (task) =>
  taskBoard.delete(task.id).pipe(
    Effect.catchAll(() => Effect.void),
  ),
)
```

Replace with a single archive call:
```ts
yield* taskBoard.archiveTeamBoard(input.teamID).pipe(
  Effect.catchAll(() => Effect.void),
)
```

### Step 10: Update existing dissolve tests (if any assert hard-delete)

- [ ] Grep for tests that assert task deletion after dissolve:
```bash
grep -rn "dissolve.*delete\|delete.*dissolve" src/team/*.test.ts
```
For each match, change `expect(tasks.length).toBe(0)` (using `repo.list` or `repo.get`) — these still work because `list`/`get` filter archived. If any test directly queries `TaskBoardTable` SQL bypassing the repo, update it to call `listArchived` to confirm soft-delete instead.

### Step 11: Run full suite

```bash
bun test src/team/ src/tool/
```
Expected: all PASS.

### Step 12: TypeScript clean

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool)/" | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```
Expected: empty.

### Step 13: Commit

```bash
git add src/team/task-board.sql.ts src/team/task-board.ts src/team/session-coordinator.ts src/team/task-board-service.test.ts migration/
git commit -m "feat(team): soft-delete task board on dissolve via archived_at (B4)"
```

---

## Task 4 (B2): remove PermissionGuard for engineers

**Files:**
- Modify: `src/session/prompt.ts` (remove 3 call sites)
- Delete: `src/team/permission-guard.ts`
- Delete: `src/team/permission-guard.test.ts`
- Modify: `src/effect/app-runtime.ts` (drop layer)
- Modify: `src/team/lifecycle-integration.test.ts` (per audit)
- Modify: `src/team/final-qa-lifecycle.test.ts` (per audit)

### Step 1: Audit all `PermissionGuard` references

```bash
grep -rn "PermissionGuard\|permissionGuard\|permission-guard" src/ | grep -v node_modules
```

Expected hits:
- `src/team/permission-guard.ts` (definition, deleting)
- `src/team/permission-guard.test.ts` (tests, deleting)
- `src/session/prompt.ts` (3 sites — removing)
- `src/effect/app-runtime.ts` (layer wiring — dropping)
- `src/team/lifecycle-integration.test.ts` (likely fixtures)
- `src/team/final-qa-lifecycle.test.ts` (likely fixtures)

If any **other** file references `PermissionGuard` outside this list, stop and reconsider — that's an unanticipated consumer.

### Step 2: Read the 3 call sites in `src/session/prompt.ts`

- Lines around 420 (native tool path)
- Lines around 465 (MCP tool path)
- Lines around 591 (TaskTool path)

Each is gated by `Effect.serviceOption(PermissionGuard.Service)`. The pattern looks like:
```ts
const guard = yield* Effect.serviceOption(PermissionGuard.Service)
if (Option.isSome(guard)) {
  yield* guard.value.enforceForTool({ ... })
}
```

### Step 3: Remove all 3 call sites

- [ ] In `src/session/prompt.ts`, locate each of the 3 sites and delete the full `Effect.serviceOption(PermissionGuard.Service)` lookup + the `if (Option.isSome(...))` block + its `enforceForTool` body.

- [ ] Remove the import of `PermissionGuard` from the top of `src/session/prompt.ts`.

- [ ] If `Option` was imported solely for the `Option.isSome(guard)` check at the guard sites, remove that import too. Verify no other use first via search.

### Step 4: Delete the service files

```bash
rm src/team/permission-guard.ts src/team/permission-guard.test.ts
```

### Step 5: Drop the layer from AppLayer

- [ ] In `src/effect/app-runtime.ts`, find `permissionGuardLayer` references and delete them:
  - The import line
  - The line in the `Layer.mergeAll(...)` (or however it's composed) that adds `permissionGuardLayer`

### Step 6: Strip fixtures from team integration tests

- [ ] In `src/team/lifecycle-integration.test.ts`, search for `PermissionGuard` usages and remove them:
  - Layer provisioning (e.g., `Layer.provide(permissionGuardLayer)` or test-only mocks)
  - Any `expect(...permissionGuard...).toHaveBeenCalled()`

- [ ] Same in `src/team/final-qa-lifecycle.test.ts`.

If a test was specifically testing PermissionGuard interaction (and not a broader lifecycle behavior), delete the entire test case.

### Step 7: Run full suite

```bash
bun test src/team/ src/tool/ src/session/
```
Expected: all PASS. If a test fails because of removed fixtures, edit the test to remove the now-orphaned assertion (don't re-add the guard).

### Step 8: TypeScript clean

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool|session|effect)/" | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```
Expected: empty.

### Step 9: Final grep — ensure zero stragglers

```bash
grep -rn "PermissionGuard\|permissionGuard\|permission-guard" src/ | grep -v node_modules
```
Expected: empty.

### Step 10: Verify `fileScope` field still serialized + displayed

Quick sanity check (no test code, just verification):
- `src/team/types.ts` — `EngineerSlot.fileScope` field still present
- `src/tool/team.ts` — `team_monitor` / `team_roster` outputs still render fileScope

If either is gone, restore (B2 doesn't touch this surface; if you accidentally broke it, it's a regression).

### Step 11: Commit

```bash
git add -A
git commit -m "refactor(team): remove PermissionGuard (worktree-per-engineer supersedes) (B2)"
```

---

## Final verification

### Step 1: Full suite

```bash
bun test src/team/ src/tool/ src/session/
```
Expected: all PASS, count ≥ 246 (A3 baseline) + new tests added.

### Step 2: TypeScript clean

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/(team|tool|session|effect)/" | grep -v "outdatedApi\|RuntimeFiber\|interruptFork\|implicitly\|Brand"
```
Expected: empty.

### Step 3: Update backlog doc

- [ ] Open `docs/team-improvements-backlog.md` and mark B1, B2, B4, B5 as ✅ done. Add a "What was completed in the 2026-04-25 sweep" section mirroring the existing "What was completed in 2026-04-22 → 2026-04-24" section. (B3 stays open with the deferral note.)
- [ ] Commit: `docs(team): mark B1/B2/B4/B5 done; B3 deferred`.

### Step 4: Report

Final tally to user: 4 commits landed, B-sweep complete except deferred B3.

---

## Self-review checklist (for plan author)

- [x] Spec coverage: B5 (Task 1), B1 (Task 2), B4 (Task 3), B2 (Task 4); B3 explicitly deferred per spec.
- [x] No "TBD"/"TODO" — every step has actual content.
- [x] Type names consistent: `archiveTeamBoard`/`listArchived`/`purgeOlderThan` used identically in interface + impl + tests.
- [x] Migration risk flagged at Step 3 of Task 3 (drizzle-kit SQLite quirks).
- [x] B2 audit grep listed first to flag unexpected consumers before deletion.
- [x] Each task ends with full-suite test + tsc clean + commit before moving on.
