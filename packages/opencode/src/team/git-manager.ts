import { Effect, Layer, Context, Schema } from "effect"
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
  }) => Effect.Effect<void, GitError | MergeConflictError>
  readonly cleanupBranches: (teamID: TeamID) => Effect.Effect<void, GitError>
  readonly getBranchStatus: (input: {
    teamID: TeamID
    engineerID: EngineerID
  }) => Effect.Effect<BranchStatus, GitError>
}

// --- Helpers ---

const branchName = (teamID: TeamID, engineerID: EngineerID) =>
  `${GIT_BRANCH_PREFIX}/${teamID}/engineer-${engineerID}`

const execGit = (args: string[]) =>
  Effect.try({
    try: () => {
      const proc = Bun.spawnSync(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
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

const globOverlap = (a: string, b: string): boolean => {
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
    }) {
      const branch = branchName(input.teamID, input.engineerID)
      const currentBranch = yield* execGit(["rev-parse", "--abbrev-ref", "HEAD"])
      yield* execGit(["checkout", currentBranch.trim()])

      yield* execGit(["merge", branch, "--no-edit"]).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const status = yield* execGit(["status", "--porcelain"]).pipe(
              Effect.catchCause(() => Effect.succeed("")),
            )
            const conflicts = status
              .split("\n")
              .filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DU"))
              .map((line) => line.slice(3).trim())

            yield* execGit(["merge", "--abort"]).pipe(Effect.catchCause(() => Effect.void))
            yield* execGit(["checkout", currentBranch.trim()]).pipe(Effect.catchCause(() => Effect.void))

            return yield* new MergeConflictError({
              message: `Merge conflict merging ${branch} into ${currentBranch.trim()}`,
              branch,
              conflictingFiles: conflicts,
            })
          }),
        ),
      )
    })

    const cleanupBranches = Effect.fn("GitManager.cleanupBranches")(function* (teamID: TeamID) {
      const prefix = `${GIT_BRANCH_PREFIX}/${teamID}/`
      const branches = yield* execGit(["branch", "--list", `${prefix}*`])

      const branchList = branches
        .split("\n")
        .map((b) => b.replace(/^\*?\s+/, "").trim())
        .filter((b) => b.length > 0)

      const currentBranch = (yield* execGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim()

      if (branchList.includes(currentBranch)) {
        const allBranches = (yield* execGit(["branch", "--list"])).split("\n")
          .map((b) => b.replace(/^\*?\s+/, "").trim())
          .filter((b) => b.length > 0 && !b.startsWith(prefix))
        const fallback = allBranches[0] ?? "master"
        yield* execGit(["checkout", fallback]).pipe(Effect.catchCause(() => Effect.void))
      }

      for (const branch of branchList) {
        yield* execGit(["branch", "-D", branch]).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }
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

    return Service.of({
      createBranch,
      detectOverlap,
      commitWork,
      mergeBranch,
      cleanupBranches,
      getBranchStatus,
    })
  }),
)

export * as GitManager from "./git-manager"
