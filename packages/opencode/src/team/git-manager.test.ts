import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Service, GitError, MergeConflictError, type BranchStatus } from "./git-manager"
import { GIT_BRANCH_PREFIX } from "./constants"
import type { EngineerID, TeamID } from "./types"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ENG_A = "eng_a" as EngineerID
const ENG_B = "eng_b" as EngineerID
const TEAM_ID = "team_test" as TeamID

const runWith = <A, E>(
  effect: Effect.Effect<A, E, Service>,
) =>
  Effect.provide(effect, testLayer).pipe(Effect.runPromise)

import { layer } from "./git-manager"

const testLayer = layer

let testDir: string

const setupRepo = () => {
  testDir = mkdtempSync(join(tmpdir(), "git-manager-test-"))
  Bun.spawnSync(["git", "init"], { cwd: testDir })
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: testDir })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: testDir })
    // Write initial commit so HEAD exists
    Bun.spawnSync(["sh", "-c", "echo init > README.md && git add . && git commit -m init"], { cwd: testDir })
}

const teardownRepo = () => {
  if (testDir) {
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  }
}

const git = (args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: testDir, stdout: "pipe", stderr: "pipe" })
  return new TextDecoder().decode(proc.stdout)
}

const branchOf = (teamID: TeamID, engineerID: EngineerID) =>
  `${GIT_BRANCH_PREFIX}/${teamID}/engineer-${engineerID}`

const defaultBranch = () => {
  const proc = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], { cwd: testDir, stdout: "pipe" })
  return new TextDecoder().decode(proc.stdout).trim()
}

describe("GitManager", () => {
  beforeEach(() => {
    setupRepo()
    process.chdir(testDir)
  })

  afterEach(() => {
    teardownRepo()
  })

  // --- detectOverlap ---

  test("detectOverlap returns true for identical scopes", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const result = await runWith(service.detectOverlap(["src/foo.ts"], ["src/foo.ts"]))
    expect(result).toBe(true)
  })

  test("detectOverlap returns true for overlapping glob patterns", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const result = await runWith(service.detectOverlap(["src/**/*.ts"], ["src/utils/helpers.ts"]))
    expect(result).toBe(true)
  })

  test("detectOverlap returns false for disjoint scopes", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const result = await runWith(service.detectOverlap(["src/auth/*"], ["src/billing/*"]))
    expect(result).toBe(false)
  })

  test("detectOverlap returns true for wildcard-only patterns", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const result = await runWith(service.detectOverlap(["*"], ["src/foo.ts"]))
    expect(result).toBe(true)
  })

  test("detectOverlap returns true when one scope is prefix of other", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const result = await runWith(service.detectOverlap(["src/"], ["src/utils/helpers.ts"]))
    expect(result).toBe(true)
  })

  // --- createBranch ---

  test("createBranch creates branch with correct name", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const branch = await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/a/*"],
    }))

    expect(branch).toBe(branchOf(TEAM_ID, ENG_A))

    const branches = git(["branch"])
    expect(branches).toContain(branch.replace(`${GIT_BRANCH_PREFIX}/`, `${GIT_BRANCH_PREFIX}/`))
  })

  test("createBranch creates separate branches for different engineers", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    const branchA = await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/a/*"],
    }))

    git(["checkout", main])

    const branchB = await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_B,
      fileScopes: ["src/b/*"],
    }))

    expect(branchA).not.toBe(branchB)
    expect(branchA).toContain(ENG_A)
    expect(branchB).toContain(ENG_B)
  })

  // --- commitWork ---

  test("commitWork commits changes to engineer branch", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))

    const branch = await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo hello > test.txt"], { cwd: testDir })

    await runWith(service.commitWork({
      engineerID: ENG_A,
      teamID: TEAM_ID,
      message: "test commit",
    }))

    const log = git(["log", "--oneline", "-1"])
    expect(log).toContain("test commit")

    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    expect(currentBranch).toBe(branch)
  })

  // --- mergeBranch ---

  test("mergeBranch merges engineer branch into main", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo merged-content > merged.txt && git add . && git commit -m eng-work"], { cwd: testDir })

    git(["checkout", main])

    await runWith(service.mergeBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    const files = git(["ls-files"])
    expect(files).toContain("merged.txt")
  })

  test("mergeBranch throws MergeConflictError on conflicts", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo eng-change > conflict.txt && git add . && git commit -m eng-conflict"], { cwd: testDir })

    git(["checkout", main])
    Bun.spawnSync(["sh", "-c", "echo main-change > conflict.txt && git add . && git commit -m main-conflict"], { cwd: testDir })

    const result = await runWith(service.mergeBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }).pipe(Effect.flip))

    expect(result).toBeInstanceOf(MergeConflictError)
    expect((result as MergeConflictError).branch).toBe(branchOf(TEAM_ID, ENG_A))
  })

  // --- cleanupBranches ---

  test("cleanupBranches removes all team branches", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/a/*"],
    }))

    git(["checkout", main])

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_B,
      fileScopes: ["src/b/*"],
    }))

    git(["checkout", main])

    await runWith(service.cleanupBranches(TEAM_ID))

    const branches = git(["branch"])
    expect(branches).not.toContain(branchOf(TEAM_ID, ENG_A))
    expect(branches).not.toContain(branchOf(TEAM_ID, ENG_B))
  })

  // --- getBranchStatus ---

  test("getBranchStatus returns ahead/behind counts", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    const branch = await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo ahead > ahead.txt && git add . && git commit -m ahead"], { cwd: testDir })

    git(["checkout", main])

    const status = await runWith(service.getBranchStatus({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    expect(status.branch).toBe(branch)
    expect(status.ahead).toBeGreaterThanOrEqual(1)
    expect(status.behind).toBe(0)
  })

  test("getBranchStatus shows behind when main is ahead", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    git(["checkout", main])
    Bun.spawnSync(["sh", "-c", "echo behind > behind.txt && git add . && git commit -m main-ahead"], { cwd: testDir })

    const status = await runWith(service.getBranchStatus({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    expect(status.behind).toBeGreaterThanOrEqual(1)
  })

  // --- mergeBranch with custom message (squash) ---

  test("mergeBranch with custom message produces one squash commit", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo work1 > work1.txt && git add . && git commit -m eng1"], { cwd: testDir })
    Bun.spawnSync(["sh", "-c", "echo work2 > work2.txt && git add . && git commit -m eng2"], { cwd: testDir })

    git(["checkout", main])

    await runWith(service.mergeBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      message: "squash: engineer work done",
    }))

    const log = git(["log", "--oneline", "-1"])
    expect(log).toContain("squash: engineer work done")

    const files = git(["ls-files"])
    expect(files).toContain("work1.txt")
    expect(files).toContain("work2.txt")
  })

  test("mergeBranch with conflict returns MergeConflictError and no merge in progress", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createBranch({
      teamID: TEAM_ID,
      engineerID: ENG_A,
      fileScopes: ["src/*"],
    }))

    Bun.spawnSync(["sh", "-c", "echo eng > clash.txt && git add . && git commit -m eng-clash"], { cwd: testDir })

    git(["checkout", main])
    Bun.spawnSync(["sh", "-c", "echo main > clash.txt && git add . && git commit -m main-clash"], { cwd: testDir })

    const result = await runWith(
      service.mergeBranch({ teamID: TEAM_ID, engineerID: ENG_A, message: "should fail" }).pipe(Effect.flip),
    )

    expect(result).toBeInstanceOf(MergeConflictError)
    expect((result as MergeConflictError).branch).toBe(branchOf(TEAM_ID, ENG_A))

    // No merge in progress after abort
    const mergeHead = Bun.spawnSync(["sh", "-c", "test -f MERGE_HEAD && echo yes || echo no"], { cwd: testDir, stdout: "pipe" })
    expect(new TextDecoder().decode(mergeHead.stdout).trim()).toBe("no")
  })

  // --- createEngineerWorktree ---

  test("createEngineerWorktree creates worktree at expected path on new branch", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))

    const result = await runWith(service.createEngineerWorktree({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    expect(result.branch).toBe(branchOf(TEAM_ID, ENG_A))
    expect(result.worktreePath).toContain(ENG_A)
    expect(result.worktreePath).toContain(TEAM_ID)

    const worktrees = git(["worktree", "list", "--porcelain"])
    expect(worktrees).toContain(result.worktreePath)
    expect(worktrees).toContain(result.branch)
  })

  test("createEngineerWorktree re-attach: calling twice does not throw", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))

    const first = await runWith(service.createEngineerWorktree({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    // Second call with the same IDs should not throw
    const second = await runWith(service.createEngineerWorktree({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    expect(second.branch).toBe(first.branch)
    expect(second.worktreePath).toBe(first.worktreePath)
  })

  // --- removeEngineerWorktree ---

  test("removeEngineerWorktree removes worktree and deletes branch", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))

    const { worktreePath, branch } = await runWith(service.createEngineerWorktree({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    await runWith(service.removeEngineerWorktree({ teamID: TEAM_ID, engineerID: ENG_A }))

    const worktrees = git(["worktree", "list", "--porcelain"])
    expect(worktrees).not.toContain(worktreePath)

    const branches = git(["branch"])
    expect(branches).not.toContain(branch)
  })

  test("removeEngineerWorktree tolerates already-gone worktree", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))

    // Remove something that was never created — should not throw
    await expect(
      runWith(service.removeEngineerWorktree({ teamID: TEAM_ID, engineerID: ENG_A })),
    ).resolves.toBeUndefined()
  })

  // --- commitInWorktree ---

  test("commitInWorktree commits on engineer branch without moving lead branch", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    const { worktreePath, branch } = await runWith(service.createEngineerWorktree({
      teamID: TEAM_ID,
      engineerID: ENG_A,
    }))

    // Write a file in the worktree dir
    Bun.spawnSync(["sh", "-c", "echo worktree-file > wt.txt"], { cwd: worktreePath })

    await runWith(service.commitInWorktree({ worktreePath, message: "engineer commit" }))

    // Lead branch has not moved
    const leadBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    expect(leadBranch).toBe(main)

    // Engineer branch has the commit
    const engLog = git(["log", "--oneline", "-1", branch])
    expect(engLog).toContain("engineer commit")
  })

  // --- cleanupBranches with worktrees ---

  test("cleanupBranches removes worktrees and branches for team", async () => {
    const service = await runWith(Effect.gen(function* () { return yield* Service }))
    const main = defaultBranch()

    await runWith(service.createEngineerWorktree({ teamID: TEAM_ID, engineerID: ENG_A }))
    await runWith(service.createEngineerWorktree({ teamID: TEAM_ID, engineerID: ENG_B }))

    await runWith(service.cleanupBranches(TEAM_ID))

    const worktrees = git(["worktree", "list", "--porcelain"])
    expect(worktrees).not.toContain(ENG_A)
    expect(worktrees).not.toContain(ENG_B)

    const branches = git(["branch"])
    expect(branches).not.toContain(branchOf(TEAM_ID, ENG_A))
    expect(branches).not.toContain(branchOf(TEAM_ID, ENG_B))

    // Lead branch unchanged
    const leadBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    expect(leadBranch).toBe(main)
  })
})
