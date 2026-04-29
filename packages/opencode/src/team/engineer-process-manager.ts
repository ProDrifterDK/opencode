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
 * Lifecycle:
 *   - Phase 2 wires the stdout event reader (forwards publishTeamEvent
 *     calls from the engineer back to the lead's Bus + GlobalBus) and
 *     the stderr drain (keeps the OS pipe buffer from filling and
 *     blocking the child).
 *   - Phase 3 (this commit) exposes `terminateSubprocess` for graceful
 *     kill with SIGTERM→SIGKILL escalation. The lead also attaches an
 *     `.exited` handler after spawn returns to detect crashes / normal
 *     exits and clean up the `running` map deterministically.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { Log } from "@/util"
import { sanitizedProcessEnv } from "@opencode-ai/core/util/opencode-process"
import type { EngineerID, TeamID } from "./types"
import { readEngineerEvents, drainEngineerStderr, engineerStderrLogger } from "./engineer-event-reader"
import { ENGINEER_KILL_TIMEOUT_MS } from "./constants"

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
  fileScope?: readonly string[]
  coordinationWarnings?: readonly string[]
  teammates?: readonly { name: string; engineerID: string; task?: string }[]
  name: string
  providerID?: string
  modelID?: string
  /**
   * Optional fallback model. Forwarded to the engineer subprocess via
   * `--fallback-provider-id` / `--fallback-model-id`. The engineer-loop
   * uses these on a `CircuitBreakerOpenError` to retry the task once.
   */
  fallbackProviderID?: string
  fallbackModelID?: string
}

/**
 * Minimal subprocess shape required by `terminateSubprocess`. Tests pass
 * fakes that satisfy this without standing up a real Bun.Subprocess.
 */
export interface KillableSubprocess {
  readonly exited: Promise<number | null | undefined>
  readonly exitCode?: number | null
  readonly killed?: boolean
  kill(signal?: number | NodeJS.Signals): unknown
}

export interface TerminateOptions {
  /** Override the default escalation timeout. */
  timeoutMs?: number
}

/**
 * Phase 3 of A3 — graceful kill helper with SIGTERM→SIGKILL escalation.
 *
 * Sends SIGTERM, waits up to `timeoutMs` for `subprocess.exited` to
 * resolve. If the child is still alive after that, sends SIGKILL and
 * waits for the final exit. Returns the OS exit code (or null if the
 * platform reports none). Idempotent: callers can invoke this in the
 * terminate path AND have the centralized exit handler observe the same
 * `.exited` promise without racing — exit cleanup keys off the
 * single `subprocess.exited` resolution.
 */
export async function terminateSubprocess(
  subprocess: KillableSubprocess,
  opts: TerminateOptions = {},
): Promise<number | null | undefined> {
  const timeoutMs = opts.timeoutMs ?? ENGINEER_KILL_TIMEOUT_MS

  // Already exited — nothing to do.
  if (subprocess.exitCode !== undefined && subprocess.exitCode !== null) {
    return subprocess.exitCode
  }

  try {
    subprocess.kill("SIGTERM")
  } catch (err) {
    log.warn("SIGTERM failed", { error: String(err) })
  }

  // Sentinel symbol so we can distinguish timeout from a real exit code.
  const TIMEOUT = Symbol("kill-timeout")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  const result = await Promise.race([subprocess.exited, timeoutPromise])
  if (timer !== undefined) clearTimeout(timer)

  if (result !== TIMEOUT) {
    return result as number | null | undefined
  }

  log.warn("engineer did not exit on SIGTERM, escalating to SIGKILL", { timeoutMs })
  try {
    subprocess.kill("SIGKILL")
  } catch (err) {
    log.warn("SIGKILL failed", { error: String(err) })
  }
  return subprocess.exited
}

export interface SpawnedEngineer {
  pid: number
  /**
   * The Bun child process handle. Phase 2 reads stdout for event
   * forwarding; Phase 3 wired `.exited` for crash detection — the lead
   * attaches a handler via `attachExitHandler` in daemon.ts after spawn returns.
   */
  subprocess: KillableSubprocess
  /**
   * Promise that resolves when the stdout JSONL reader has finished
   * draining. The exit handler awaits this BEFORE reconciling DB state
   * to close a race: a clean-exit engineer publishes `EngineerCompleted`
   * to stdout right before exit, and the line can still be buffered
   * when `.exited` resolves. See daemon-running.ts for details.
   */
  eventReaderDone: Promise<void>
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnedEngineer, SpawnError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/EngineerProcessManager",
) {}

/**
 * Resolve the binary that the lead is currently running so we can spawn
 * the engineer using the same opencode build.
 *
 * Two cases:
 *   1. Standalone Bun-compiled binary (production install). `execPath`
 *      is the opencode binary itself, and `argv[1]` is the user's first
 *      positional (e.g. project path) — NOT a script. Return [execPath]
 *      only; appending argv[1] would inject the user's project path
 *      into the engineer subprocess command line and yargs would treat
 *      `team-engineer-run` as an unknown extra positional.
 *   2. Dev mode (`bun run src/index.ts`). `execPath` is the bun
 *      runtime, and `argv[1]` is the entry script. Return [bun, script]
 *      so the subprocess invokes the same script under the same bun.
 *
 * We distinguish by checking whether `argv[1]` looks like a script path
 * (ends with .js/.ts/.mjs/.tsx).
 */
function resolveOpencodeCommand(): string[] {
  const bun = process.execPath || process.argv[0]
  const script = process.argv[1]
  // Three cases to distinguish:
  //   1. Compiled binary, launched directly: argv0 = opencode binary,
  //      argv1 = user's first positional or undefined → return [execPath]
  //   2. Compiled binary, running as TUI worker subprocess: argv1 is
  //      a `/$bunfs/...` virtual path inside Bun's sandbox; passing it
  //      to a child process is meaningless and yargs in the child would
  //      treat it as a positional → return [execPath]
  //   3. Dev mode (`bun run src/index.ts`): argv0 = bun binary,
  //      argv1 = real on-disk script path → return [bun, script]
  const isRealScript =
    typeof script === "string" &&
    !script.startsWith("/$bunfs/") &&
    /\.(?:js|ts|mjs|tsx)$/.test(script)
  if (isRealScript) return [bun, script]
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
          if (input.fileScope && input.fileScope.length > 0) args.push("--file-scope", JSON.stringify(input.fileScope))
          if (input.coordinationWarnings && input.coordinationWarnings.length > 0) {
            args.push("--coordination-warnings", JSON.stringify(input.coordinationWarnings))
          }
          if (input.teammates && input.teammates.length > 0) args.push("--teammates", JSON.stringify(input.teammates))
          if (input.providerID) args.push("--provider-id", input.providerID)
          if (input.modelID) args.push("--model-id", input.modelID)
          if (input.fallbackProviderID) args.push("--fallback-provider-id", input.fallbackProviderID)
          if (input.fallbackModelID) args.push("--fallback-model-id", input.fallbackModelID)

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
              // Phase 2 of A3: tells `publishTeamEvent` (in events.ts)
              // to write events as JSON-lines on stdout instead of
              // emitting on GlobalBus, since GlobalBus is process-local
              // and would never reach the lead. The reader below
              // decodes those lines and republishes them on the lead's
              // Bus + GlobalBus.
              OPENCODE_TEAM_ENGINEER: "1",
            }),
          })

          if (typeof subprocess.pid !== "number") {
            throw new Error("Bun.spawn did not return a pid")
          }

          // Phase 2 of A3: attach the stdout event reader and stderr
          // drain. Both run as detached promises that resolve when the
          // child closes its respective pipe; we don't await them here
          // (the engineer outlives this spawn call). Phase 3 attaches
          // the `.exited` watcher in `daemon.ts` after spawn returns;
          // the readers naturally end before that promise resolves.
          //
          // The pipes are typed as ReadableStream<Uint8Array> by Bun.
          // If for some reason a runtime returns null (e.g. mocked
          // subprocess in a test) we just skip drainage rather than
          // throwing — keeping spawn itself defensive.
          const stdout = subprocess.stdout as ReadableStream<Uint8Array> | null | undefined
          const stderr = subprocess.stderr as ReadableStream<Uint8Array> | null | undefined
          // Capture the stdout-reader promise so the exit handler can
          // await it before reconciling DB state. If stdout is missing
          // (test fakes) we resolve immediately so the await is a no-op.
          const eventReaderDone =
            stdout && typeof stdout.getReader === "function"
              ? readEngineerEvents(stdout)
              : Promise.resolve()
          if (stderr && typeof stderr.getReader === "function") {
            // Route engineer stderr through the lead's structured Log so
            // crash messages land in the main log file (under
            // service=engineer-stderr) instead of the lead's TUI.
            void drainEngineerStderr(stderr, engineerStderrLogger(engineerID))
          }

          log.info("engineer subprocess spawned", {
            engineerID,
            pid: subprocess.pid,
          })

          return { pid: subprocess.pid, subprocess, eventReaderDone }
        },
        catch: (err) =>
          new SpawnError({
            message: `failed to spawn engineer subprocess: ${String(err)}`,
          }),
      }),
  }),
)
