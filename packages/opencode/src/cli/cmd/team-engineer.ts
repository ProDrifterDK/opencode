/**
 * team-engineer-run - internal CLI subcommand executed by the lead's
 * `EngineerProcessManager` to launch one engineer in its own
 * subprocess.
 *
 * Phase 1 of A3 (subprocess-per-engineer): replaces the in-process
 * Effect fiber model. The lead spawns this command per engineer; if
 * the engineer crashes or runs out of memory, only this subprocess
 * dies — the lead survives.
 *
 * Hidden: end users do not invoke this directly. It is launched by
 * `Bun.spawn` from `team/engineer-process-manager.ts`. The lead passes
 * task/model metadata in via CLI args because the EngineerSlot row
 * does not persist title/description/providerID/modelID — those live
 * transiently in the engineer.spawned event payload.
 */
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { runEngineerLoop } from "@/team/engineer-loop"
import { runPermissionAutoReplier } from "./skip-permissions"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "@/server"

const log = Log.create({ service: "cli.team-engineer-run" })

export const TeamEngineerRunCommand = cmd({
  command: "team-engineer-run",
  describe: false, // hidden — internal helper, not for end users
  builder: (yargs) =>
    yargs
      .option("team-id", {
        type: "string",
        describe: "team identifier (internal)",
        demandOption: true,
      })
      .option("engineer-id", {
        type: "string",
        describe: "engineer slot identifier (internal)",
        demandOption: true,
      })
      .option("session-id", {
        type: "string",
        describe: "session identifier the lead pre-created for this engineer",
        demandOption: true,
      })
      .option("worktree-path", {
        type: "string",
        describe: "absolute path to this engineer's git worktree",
        demandOption: true,
      })
      .option("name", {
        type: "string",
        describe: "engineer display name",
        demandOption: true,
      })
      .option("task-id", {
        type: "string",
        describe: "task identifier the engineer is assigned",
        demandOption: true,
      })
      .option("task-title", {
        type: "string",
        describe: "task title",
        demandOption: true,
      })
      .option("task-description", {
        type: "string",
        describe: "task description",
        demandOption: true,
      })
      .option("provider-id", {
        type: "string",
        describe: "LLM provider id (optional, falls back to session default)",
      })
      .option("model-id", {
        type: "string",
        describe: "LLM model id (optional, falls back to session default)",
      })
      .option("fallback-provider-id", {
        type: "string",
        describe: "fallback LLM provider id (optional, used on CircuitBreakerOpenError)",
      })
      .option("fallback-model-id", {
        type: "string",
        describe: "fallback LLM model id (optional, used on CircuitBreakerOpenError)",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions for tool calls (required for unattended engineers)",
        default: false,
      }),
  handler: async (args) => {
    const teamID = String(args["team-id"])
    const engineerID = String(args["engineer-id"])
    const sessionID = String(args["session-id"]) as SessionID
    const worktreePath = String(args["worktree-path"])
    const name = String(args["name"])
    const taskID = String(args["task-id"])
    const taskTitle = String(args["task-title"])
    const taskDescription = String(args["task-description"])
    const providerID = args["provider-id"] ? String(args["provider-id"]) : undefined
    const modelID = args["model-id"] ? String(args["model-id"]) : undefined
    const fallbackProviderID = args["fallback-provider-id"] ? String(args["fallback-provider-id"]) : undefined
    const fallbackModelID = args["fallback-model-id"] ? String(args["fallback-model-id"]) : undefined
    const skipPerms = Boolean(args["dangerously-skip-permissions"])

    // Mirror env var so any downstream code that reads it (Phase 2/3)
    // sees a consistent signal regardless of whether the flag came in
    // as CLI arg or env.
    if (skipPerms) process.env.OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS = "1"

    log.info("engineer subprocess starting", {
      teamID,
      engineerID,
      sessionID,
      worktreePath,
      skipPermissions: skipPerms,
      pid: process.pid,
    })

    try {
      await bootstrap(worktreePath, async () => {
        const engineerLoopPromise = AppRuntime.runPromise(
          runEngineerLoop({
            teamID,
            engineerID,
            sessionID,
            name,
            taskId: taskID,
            taskTitle,
            taskDescription,
            providerID,
            modelID,
            fallbackProviderID,
            fallbackModelID,
            // Engineer runs without peer awareness; `teammates: []` is a
            // known gap (backlog: A3-followup teammate hydration). The
            // value is used to address mailbox messages between engineers.
            teammates: [],
          }),
        )

        // When --dangerously-skip-permissions is set, run the auto-replier
        // concurrently with the engineer loop. It subscribes to the event
        // stream and replies "once" to every permission.asked for this
        // session, preventing the engineer from deadlocking on prompts.
        // The AbortController ensures the replier shuts down cleanly
        // once the engineer loop completes (or fails).
        if (skipPerms) {
          const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            return Server.Default().app.fetch(request)
          }) as typeof globalThis.fetch
          const sdk = createOpencodeClient({
            baseUrl: "http://opencode.internal",
            fetch: fetchFn,
          })

          const ac = new AbortController()
          const replierPromise = runPermissionAutoReplier(sdk, sessionID, ac.signal).catch(
            () => {
              // Ignore errors from the replier (e.g. stream closed after abort)
            },
          )

          try {
            await engineerLoopPromise
          } finally {
            ac.abort()
            await replierPromise
          }
        } else {
          await engineerLoopPromise
        }
      })

      log.info("engineer subprocess completed", { engineerID, pid: process.pid })
      process.exitCode = 0
    } catch (err) {
      log.error("engineer subprocess failed", {
        engineerID,
        error: String(err),
      })
      process.stderr.write(`engineer subprocess failed: ${String(err)}\n`)
      process.exitCode = 1
    }
  },
})
