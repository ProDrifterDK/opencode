/**
 * EngineerProcessManager - spawns engineer subprocesses.
 *
 * Phase 1 of A3 (subprocess-per-engineer). The lead used to fork an
 * Effect fiber per engineer inside its own process; a crashing or
 * OOM-killed engineer would take the lead with it. Now the lead spawns
 * `opencode team-engineer-run` as a Bun subprocess for each engineer.
 *
 * The default layer uses `Bun.spawn`. Tests can substitute a layer that
 * returns a fake handle so they don't actually fork bun processes.
 *
 * Notes for Phase 2 / Phase 3:
 *   - stdio is piped but unread today; Phase 2 owns the stdout reader
 *     for forwarding engineer events back to the lead's bus.
 *   - No `.exited` handler is attached; Phase 3 will wire crash
 *     detection and clean up stale slots in `RunningEngineer`.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { Log } from "@/util"
import { sanitizedProcessEnv } from "@/util/opencode-process"
import type { EngineerID, TeamID } from "./types"

const log = Log.create({ service: "team.engineer-process-manager" })

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()(
  "EngineerSpawnError",
  {
    message: Schema.String,
  },
) {}

export interface SpawnInput {
  teamID: TeamID
  engineerID: EngineerID
  sessionID: string
  worktreePath: string
  /**
   * Task and model metadata. These are not stored on the EngineerSlot
   * row today (they live transiently in the engineer.spawned event
   * payload), so the lead has to forward them on the spawn args.
   */
  taskID: string
  taskTitle: string
  taskDescription: string
  name: string
  providerID?: string
  modelID?: string
}

export interface SpawnedEngineer {
  pid: number
  /**
   * The Bun child process handle. Held but not consumed in Phase 1.
   * Phase 2 will read stdout for event forwarding; Phase 3 will attach
   * crash-detection on `.exited`.
   */
  subprocess: import("bun").Subprocess
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnedEngineer, SpawnError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/EngineerProcessManager",
) {}

/**
 * Resolve the binary that the lead is currently running so we can spawn
 * the engineer using the same opencode build. We bias toward
 * `process.execPath` (the bun runtime that booted the lead) plus the
 * lead's main script, falling back to `process.argv[0]` for safety.
 */
function resolveOpencodeCommand(): string[] {
  // process.argv[0] is the bun binary; argv[1] is the script path
  // (e.g. /path/to/dist/index.js). Spawning the same script under the
  // same bun ensures we don't accidentally diverge versions in dev.
  const bun = process.execPath || process.argv[0]
  const script = process.argv[1]
  if (script) return [bun, script]
  return [bun]
}

/**
 * Default Bun.spawn-based layer. The engineer subprocess is invoked
 * with `--dangerously-skip-permissions` so it auto-approves tool
 * permission asks (engineers run unattended; without this they would
 * deadlock on `permission.asked`). The flag is also exposed via
 * `OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS=1` for code paths that prefer
 * an env signal.
 */
export const layer: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    spawn: (input) =>
      Effect.try({
        try: () => {
          const { teamID, engineerID, sessionID, worktreePath } = input
          const cmd = resolveOpencodeCommand()
          const args = [
            ...cmd,
            "team-engineer-run",
            "--team-id",
            teamID,
            "--engineer-id",
            engineerID,
            "--session-id",
            sessionID,
            "--worktree-path",
            worktreePath,
            "--name",
            input.name,
            "--task-id",
            input.taskID,
            "--task-title",
            input.taskTitle,
            "--task-description",
            input.taskDescription,
            "--dangerously-skip-permissions",
          ]
          if (input.providerID) args.push("--provider-id", input.providerID)
          if (input.modelID) args.push("--model-id", input.modelID)

          log.info("spawning engineer subprocess", {
            teamID,
            engineerID,
            sessionID,
            worktreePath,
            cmd: cmd[0],
          })

          const subprocess = Bun.spawn(args, {
            cwd: worktreePath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: sanitizedProcessEnv({
              OPENCODE_PROCESS_ROLE: "worker",
              OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS: "1",
              OPENCODE_TEAM_ID: teamID,
              OPENCODE_ENGINEER_ID: engineerID,
            }),
          })

          if (typeof subprocess.pid !== "number") {
            throw new Error("Bun.spawn did not return a pid")
          }

          log.info("engineer subprocess spawned", {
            engineerID,
            pid: subprocess.pid,
          })

          return { pid: subprocess.pid, subprocess }
        },
        catch: (err) =>
          new SpawnError({
            message: `failed to spawn engineer subprocess: ${String(err)}`,
          }),
      }),
  }),
)
