import { Effect, Layer, Context, Schema, Cause } from "effect"
import { join } from "node:path"
import { TeamID, EngineerID } from "./types"
import { GIT_BRANCH_PREFIX } from "./constants"

// --- Errors ---

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  message: Schema.String,
}) {}

export class MergeConflictError extends Schema.TaggedErrorClass<MergeConflictError>()("MergeConflictError", {
  message: Schema.String,
  branch: Schema.String,
  conflictingFiles: Schema.Array(Schema.String),
}) {}

// --- Types ---

export interface BranchStatus {
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly hasConflicts: boolean
  readonly conflictingFiles: readonly string[]
}

export interface EngineerWorktreeEntry {
  readonly engineerID: string
  readonly worktreePath: string
  readonly branch: string
}

export interface Interface {
  readonly createBranch: (input: {
    teamID: TeamID
    engineerID: EngineerID
    fileScopes: readonly string[]
  }) => Effect.Effect<string, GitError>
  readonly detectOverlap: (
    fileScopesA: readonly string[],
    fileScopesB: readonly string[],
  ) => Effect.Effect<boolean, never>
  readonly commitWork: (input: {
    engineerID: EngineerID
    teamID: TeamID
    message: string
  }) => Effect.Effect<void, GitError>
  readonly mergeBranch: (input: {
    teamID: TeamID
    engineerID: EngineerID
    message?: string
  }) => Effect.Effect<void, GitError | MergeConflictError>
  readonly cleanupBranches: (teamID: TeamID) => Effect.Effect<void, GitError>
  readonly getBranchStatus: (input: {
    teamID: TeamID
    engineerID: EngineerID
  }) => Effect.Effect<BranchStatus, GitError>
  readonly commitOnCurrentBranch: (message: string) => Effect.Effect<void, GitError>
  // Phase 1: worktree primitives
  readonly createEngineerWorktree: (input: {
    teamID: TeamID
    engineerID: EngineerID
    baseBranch?: string
  }) => Effect.Effect<{ worktreePath: string; branch: string }, GitError>
  readonly removeEngineerWorktree: (input: {
    teamID: TeamID
    engineerID: EngineerID
    worktreePath?: string
    deleteBranch?: boolean
  }) => Effect.Effect<void, GitError>
  readonly commitInWorktree: (input: {
    worktreePath: string
    message: string
  }) => Effect.Effect<void, GitError>
  readonly listEngineerWorktrees: (
    teamID: TeamID,
  ) => Effect.Effect<readonly EngineerWorktreeEntry[], GitError>
}

// --- Helpers ---

const branchName = (teamID: TeamID, engineerID: EngineerID) =>
  `${GIT_BRANCH_PREFIX}/${teamID}/engineer-${engineerID}`

const execGit = (args: string[], cwd?: string) =>
  Effect.try({
    try: () => {
      const proc = Bun.spawnSync(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        ...(cwd ? { cwd } : {}),
      })
      const stdout = new TextDecoder().decode(proc.stdout)
      const stderr = new TextDecoder().decode(proc.stderr)
      if (proc.exitCode !== 0) {
        throw new Error(stderr.trim() || `exit code ${proc.exitCode}`)
      }
      return stdout
    },
    catch: (cause) => new GitError({ message: `git ${args.join(" ")}: ${String(cause)}` }),
  })

const STRIP_GLOB = /(\/\*{1,2})+(\.\w+)?$|^\*+$/

export const globOverlap = (a: string, b: string): boolean => {
  if (a === b) return true
  const normA = a.replace(STRIP_GLOB, "").replace(/\/+$/, "")
  const normB = b.replace(STRIP_GLOB, "").replace(/\/+$/, "")
  if (!normA || !normB) return true
  return normA.startsWith(normB + "/") || normB.startsWith(normA + "/") || normA === normB
}

// --- Service ---

export class Service extends Context.Service<Service, Interface>()("@opencode/GitManager") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const createBranch = Effect.fn("GitManager.createBranch")(function* (input: {
      teamID: TeamID
      engineerID: EngineerID
      fileScopes: readonly string[]
    }) {
      const branch = branchName(input.teamID, input.engineerID)
      yield* execGit(["checkout", "-b", branch])

      return branch
    })

    const detectOverlap = Effect.fn("GitManager.detectOverlap")(
      (fileScopesA: readonly string[], fileScopesB: readonly string[]) =>
        Effect.sync(() =>
          fileScopesA.some((a) => fileScopesB.some((b) => globOverlap(a, b))),
        ),
    )

    const commitWork = Effect.fn("GitManager.commitWork")(function* (input: {
      engineerID: EngineerID
      teamID: TeamID
      message: string
    }) {
      const branch = branchName(input.teamID, input.engineerID)
      yield* execGit(["checkout", branch])
      yield* execGit(["add", "--all"])
      yield* execGit(["commit", "--allow-empty", "-m", input.message])
    })

    const mergeBranch = Effect.fn("GitManager.mergeBranch")(function* (input: {
      teamID: TeamID
      engineerID: EngineerID
      message?: string
    }) {
      const branch = branchName(input.teamID, input.engineerID)
      const currentBranch = (yield* execGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const commitMsg = input.message ?? `Merge ${branch} into ${currentBranch}`

      yield* execGit(["merge", "--squash", branch]).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const status = yield* execGit(["status", "--porcelain"]).pipe(
              Effect.catchCause(() => Effect.succeed("")),
            )
            const conflicts = status
              .split("\n")
              .filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DU"))
              .map((line) => line.slice(3).trim())

            // squash merges don't set MERGE_HEAD, so --abort won't work; use reset --merge
            yield* execGit(["reset", "--merge"]).pipe(Effect.catchCause(() => Effect.void))

            return yield* new MergeConflictError({
              message: `Merge conflict merging ${branch} into ${currentBranch}`,
              branch,
              conflictingFiles: conflicts,
            })
          }),
        ),
      )

      yield* execGit(["commit", "--allow-empty", "-m", commitMsg])
    })

    const listEngineerWorktrees = Effect.fn("GitManager.listEngineerWorktrees")(function* (teamID: TeamID) {
      const prefix = `${GIT_BRANCH_PREFIX}/${teamID}/engineer-`
      const raw = yield* execGit(["worktree", "list", "--porcelain"])

      // Parse porcelain output: blocks separated by blank lines
      // Each block has: worktree <path>\nHEAD <sha>\nbranch refs/heads/<branch>
      const entries: EngineerWorktreeEntry[] = []
      const blocks = raw.split(/\n\n+/)
      for (const block of blocks) {
        const lines = block.trim().split("\n")
        let worktreePath = ""
        let branch = ""
        for (const line of lines) {
          if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length).trim()
          if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length).trim()
        }
        if (!worktreePath || !branch) continue
        if (!branch.startsWith(prefix)) continue
        // Extract engineerID from branch suffix "engineer-<id>"
        const engineerID = branch.slice(prefix.length)
        entries.push({ engineerID, worktreePath, branch })
      }
      return entries as readonly EngineerWorktreeEntry[]
    })

    const cleanupBranches = Effect.fn("GitManager.cleanupBranches")(function* (teamID: TeamID) {
      // First remove all worktrees for this team
      const worktrees = yield* listEngineerWorktrees(teamID).pipe(
        Effect.catchCause(() => Effect.succeed([] as readonly EngineerWorktreeEntry[])),
      )
      for (const wt of worktrees) {
        yield* execGit(["worktree", "remove", "--force", wt.worktreePath]).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }
      // Prune stale worktree entries
      yield* execGit(["worktree", "prune"]).pipe(Effect.catchCause(() => Effect.void))

      // Now delete branches
      const prefix = `${GIT_BRANCH_PREFIX}/${teamID}/`
      const branches = yield* execGit(["branch", "--list", `${prefix}*`])

      const branchList = branches
        .split("\n")
        .map((b) => b.replace(/^\*?\s+/, "").trim())
        .filter((b) => b.length > 0)

      for (const branch of branchList) {
        yield* execGit(["branch", "-D", branch]).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }
    })

    const createEngineerWorktree = Effect.fn("GitManager.createEngineerWorktree")(function* (input: {
      teamID: TeamID
      engineerID: EngineerID
      baseBranch?: string
    }) {
      const repoRoot = (yield* execGit(["rev-parse", "--show-toplevel"])).trim()
      const worktreePath = join(repoRoot, ".tmp", "team", input.teamID, input.engineerID)
      const branch = branchName(input.teamID, input.engineerID)
      const base = input.baseBranch
        ? input.baseBranch
        : (yield* execGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim()

      // Try creating new branch + worktree; fall back to attaching existing branch
      yield* execGit(["worktree", "add", "-b", branch, worktreePath, base]).pipe(
        Effect.catchCause((cause) => {
          const msg = String(Cause.squash(cause))
          // Branch or worktree path already exists — try attaching the existing branch
          if (msg.includes("already exists") || msg.includes("ya existe") || msg.includes("already checked out")) {
            return execGit(["worktree", "add", worktreePath, branch]).pipe(
              Effect.catchCause((innerCause) => {
                const innerMsg = String(Cause.squash(innerCause))
                // Worktree path is already registered — treat as success
                if (
                  innerMsg.includes("already exists") ||
                  innerMsg.includes("ya existe") ||
                  innerMsg.includes("already registered") ||
                  innerMsg.includes("already checked out")
                ) {
                  return Effect.void
                }
                return Effect.failCause(innerCause)
              }),
            )
          }
          return Effect.failCause(cause)
        }),
      )

      return { worktreePath, branch }
    })

    const removeEngineerWorktree = Effect.fn("GitManager.removeEngineerWorktree")(function* (input: {
      teamID: TeamID
      engineerID: EngineerID
      worktreePath?: string
      deleteBranch?: boolean
    }) {
      const repoRoot = (yield* execGit(["rev-parse", "--show-toplevel"])).trim()
      const wPath = input.worktreePath ?? join(repoRoot, ".tmp", "team", input.teamID, input.engineerID)
      const branch = branchName(input.teamID, input.engineerID)
      const shouldDeleteBranch = input.deleteBranch ?? true

      yield* execGit(["worktree", "remove", "--force", wPath]).pipe(
        Effect.catchCause(() => Effect.void),
      )

      if (shouldDeleteBranch) {
        yield* execGit(["branch", "-D", branch]).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }
    })

    const commitInWorktree = Effect.fn("GitManager.commitInWorktree")(function* (input: {
      worktreePath: string
      message: string
    }) {
      yield* execGit(["add", "--all"], input.worktreePath)
      yield* execGit(["commit", "--allow-empty", "-m", input.message], input.worktreePath)
    })

    const getBranchStatus = Effect.fn("GitManager.getBranchStatus")(function* (input: {
      teamID: TeamID
      engineerID: EngineerID
    }) {
      const branch = branchName(input.teamID, input.engineerID)
      const currentBranch = (yield* execGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim()

      const aheadStr = yield* execGit([
        "rev-list", "--count", `${currentBranch}..${branch}`,
      ]).pipe(
        Effect.catchCause(() => Effect.succeed("0")),
      )

      const behindStr = yield* execGit([
        "rev-list", "--count", `${branch}..${currentBranch}`,
      ]).pipe(
        Effect.catchCause(() => Effect.succeed("0")),
      )

      const ahead = Number(aheadStr.trim()) || 0
      const behind = Number(behindStr.trim()) || 0

      const diffStatus = yield* execGit([
        "diff", "--name-only", "--diff-filter=U", `${currentBranch}...${branch}`,
      ]).pipe(Effect.catchCause(() => Effect.succeed("")))

      const hasConflicts = diffStatus.trim().length > 0

      return {
        branch,
        ahead,
        behind,
        hasConflicts,
        conflictingFiles: [] as string[],
      } satisfies BranchStatus
    })

    const commitOnCurrentBranch = Effect.fn("GitManager.commitOnCurrentBranch")(function* (message: string) {
      yield* execGit(["add", "--all"])
      yield* execGit(["commit", "--allow-empty", "-m", message])
    })

    return Service.of({
      createBranch,
      detectOverlap,
      commitWork,
      mergeBranch,
      cleanupBranches,
      getBranchStatus,
      commitOnCurrentBranch,
      createEngineerWorktree,
      removeEngineerWorktree,
      commitInWorktree,
      listEngineerWorktrees,
    })
  }),
)

export * as GitManager from "./git-manager"
