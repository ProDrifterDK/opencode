/**
 * EngineerEventReader - drains an engineer subprocess's stdio and forwards
 * its team events back to the lead's Bus + GlobalBus.
 *
 * Phase 2 of A3 (subprocess-per-engineer).
 *
 * In the engineer subprocess, `publishTeamEvent` writes events to stdout
 * as JSON-lines. The lead spawns the subprocess with `stdout: "pipe"` and
 * `stderr: "pipe"`. This module:
 *
 *   - reads stdout line-by-line, JSON-parses each line, validates the
 *     event has a known team event `type`, and republishes onto the
 *     lead's Bus and GlobalBus so the daemon and TUI both observe it
 *   - drains stderr to the lead's stderr (otherwise the OS pipe buffer
 *     fills and the engineer blocks on its next write)
 *
 * Both readers are defensive: malformed JSON, oversized lines, and
 * unknown event types are logged + skipped, never thrown. The reader
 * runs as a detached promise; it ends naturally when the underlying
 * stream closes.
 *
 * Phase 3 added `.exited` plumbing for crash detection via
 * `attachExitHandler` in daemon.ts — this module's reader naturally
 * ends when stdout closes; the exit handler calls `deleteRunning` and
 * reconciles DB state after the exit promise resolves.
 */
import { Exit, Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import * as Bus from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util"
import { Event } from "./events"

const log = Log.create({ service: "team.engineer-event-reader" })

/**
 * Hard cap on a single JSON-line. Engineer events are small structured
 * records; anything bigger than this is almost certainly garbage from
 * a child process that mis-routed log output to stdout. Drop it loudly
 * rather than letting an attacker (or a noisy bug) blow up our memory.
 */
export const MAX_LINE_BYTES = 1024 * 1024 // 1 MB

/**
 * Set of known team event types. Computed from the Event registry so
 * adding a new event in events.ts doesn't require updating this list.
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(Event).map((def) => (def as BusEvent.Definition).type),
)

export interface ReaderHooks {
  /**
   * Called for every successfully decoded + validated event. Defaults
   * to publishing on the local process Bus + GlobalBus. Tests inject a
   * spy here.
   */
  readonly onEvent?: (event: { type: string; properties: unknown }) => void
  /**
   * Called for every malformed / oversized / unknown line. Defaults to
   * a warn-level log. Tests inject a spy here to assert the line was
   * dropped (vs. crashing the reader).
   */
  readonly onError?: (reason: string, sample: string) => void
}

const defaultOnEvent = (event: { type: string; properties: unknown }) => {
  // Republish onto the lead's local Bus so backend subscribers (the
  // daemon's handleEngineerSpawned, handlePartUpdated, etc.) see it.
  // The cast mirrors the dynamic shape — Bus.publish's overload only
  // accepts a BusEvent.Definition + matching properties, but here we
  // just have a raw {type, properties} pair off the wire. Look up the
  // matching definition from the registry by type.
  const def = findDefinition(event.type)
  if (!def) {
    // findDefinition mirrors the KNOWN_EVENT_TYPES check; if we got
    // here something is wrong. Drop quietly — onError already fired.
    return
  }
  // Validate properties against the schema before republishing. A
  // subprocess that emits a known event type but with the wrong shape
  // is a programming error in the engineer; we don't want to inject
  // garbage into the lead's bus.
  const decoded = Schema.decodeUnknownExit(def.properties as unknown as Schema.Decoder<unknown>)(event.properties)
  if (Exit.isFailure(decoded)) {
    log.warn("engineer event failed schema validation", {
      type: event.type,
      error: String(decoded.cause),
    })
    return
  }
  const data = decoded.value
  Bus.publish(def, data as never).catch((err) => {
    const msg = String(err)
    if (!msg.includes("No context found for instance")) {
      log.error("failed to republish engineer event", { type: event.type, error: msg })
    }
  })
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: event.type, properties: data },
  })
}

function findDefinition(type: string): BusEvent.Definition | undefined {
  for (const def of Object.values(Event)) {
    const d = def as BusEvent.Definition
    if (d.type === type) return d
  }
  return undefined
}

/**
 * Decode a single JSON-line into an event. Returns null on any error
 * (with `onError` invoked). Pure, no I/O — this is the unit-testable
 * core that doesn't require ReadableStream plumbing.
 */
export function decodeEventLine(
  line: string,
  hooks: Pick<ReaderHooks, "onError"> = {},
): { type: string; properties: unknown } | null {
  const onError = hooks.onError ?? ((reason, sample) => log.warn(reason, { sample }))
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  if (Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) {
    onError("engineer event line exceeds MAX_LINE_BYTES", trimmed.slice(0, 200))
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    onError(`engineer event JSON parse failed: ${String(err)}`, trimmed.slice(0, 200))
    return null
  }
  if (typeof parsed !== "object" || parsed === null) {
    onError("engineer event is not an object", trimmed.slice(0, 200))
    return null
  }
  const obj = parsed as { type?: unknown; properties?: unknown }
  if (typeof obj.type !== "string" || obj.type.length === 0) {
    onError("engineer event missing string type", trimmed.slice(0, 200))
    return null
  }
  if (!KNOWN_EVENT_TYPES.has(obj.type)) {
    onError(`engineer event has unknown type: ${obj.type}`, trimmed.slice(0, 200))
    return null
  }
  if (typeof obj.properties !== "object" || obj.properties === null) {
    onError("engineer event missing properties object", trimmed.slice(0, 200))
    return null
  }
  return { type: obj.type, properties: obj.properties }
}

/**
 * Drain a ReadableStream of bytes, splitting on newlines, and forward
 * each decoded event via `hooks.onEvent`. Returns a promise that
 * resolves when the stream closes. Never throws — stream errors and
 * malformed lines are logged + swallowed.
 *
 * Lines longer than MAX_LINE_BYTES are dropped; the buffer is also
 * reset so a runaway producer can't OOM us.
 */
export async function readEngineerEvents(
  stdout: ReadableStream<Uint8Array>,
  hooks: ReaderHooks = {},
): Promise<void> {
  const onEvent = hooks.onEvent ?? defaultOnEvent
  const onError = hooks.onError ?? ((reason, sample) => log.warn(reason, { sample }))
  const reader = stdout.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Defensive cap on the unfinished line — without this a producer
      // that never emits a newline would grow `buffer` without bound.
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        onError("engineer stdout exceeded MAX_LINE_BYTES with no newline; resetting buffer", buffer.slice(0, 200))
        buffer = ""
        continue
      }
      let nlIdx: number
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx)
        buffer = buffer.slice(nlIdx + 1)
        const decoded = decodeEventLine(line, { onError })
        if (decoded) {
          try {
            onEvent(decoded)
          } catch (err) {
            log.error("engineer event handler threw", { type: decoded.type, error: String(err) })
          }
        }
      }
    }
    // Flush any trailing partial line if it happens to be a complete
    // JSON record (some writers omit the final newline).
    const tail = buffer + decoder.decode()
    if (tail.length > 0) {
      const decoded = decodeEventLine(tail, { onError })
      if (decoded) {
        try {
          onEvent(decoded)
        } catch (err) {
          log.error("engineer event handler threw", { type: decoded.type, error: String(err) })
        }
      }
    }
  } catch (err) {
    log.warn("engineer stdout reader stopped on error", { error: String(err) })
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // releaseLock throws if the reader was already closed — fine.
    }
  }
}

/**
 * Drain a ReadableStream of bytes from an engineer subprocess. The
 * default sink is a no-op that simply consumes the bytes — this keeps
 * the OS pipe buffer empty so the engineer doesn't block on a full
 * stderr, but does NOT forward those bytes to the lead's
 * `process.stderr`. The lead typically runs as a TUI; writing raw
 * stderr bytes there corrupts the curses-style UI with stack-trace
 * fragments and bundled source paths.
 *
 * Callers that want to capture engineer stderr (recommended) should
 * pass an explicit sink built from `engineerStderrLogger(engineerID)`,
 * which buffers lines and forwards them through the lead's structured
 * `Log` so they land in the main log file under `service=engineer-stderr`.
 *
 * Returns a promise that resolves when the stream closes. Never throws.
 */
export async function drainEngineerStderr(
  stderr: ReadableStream<Uint8Array>,
  sink: { write: (chunk: Uint8Array) => unknown } = NOOP_STDERR_SINK,
): Promise<void> {
  const reader = stderr.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      try {
        sink.write(value)
      } catch (err) {
        // If the sink is broken there's nothing useful to do.
        // Keep draining the source so the engineer doesn't block.
        log.warn("engineer stderr sink write failed", { error: String(err) })
      }
    }
    // Let line-buffered sinks flush a final partial line on close.
    try {
      const flushable = sink as { flush?: () => unknown }
      if (typeof flushable.flush === "function") flushable.flush()
    } catch (err) {
      log.warn("engineer stderr sink flush failed", { error: String(err) })
    }
  } catch (err) {
    log.warn("engineer stderr drain stopped on error", { error: String(err) })
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

const NOOP_STDERR_SINK = {
  write: (_chunk: Uint8Array) => {
    // Intentionally empty: drains the pipe without forwarding.
  },
}

/**
 * Build a stderr sink that decodes UTF-8 bytes, splits on newlines,
 * and emits each non-empty line via the lead's structured logger at
 * WARN level. Lines are tagged with the engineer's identity so they
 * can be grepped easily out of the main log.
 *
 * The sink is line-buffered: a partial trailing line is held until the
 * next chunk completes it, or until `flush()` is called when the
 * stream closes (drainEngineerStderr does this automatically).
 */
export function engineerStderrLogger(engineerID: string): {
  write: (chunk: Uint8Array) => void
  flush: () => void
} {
  const stderrLog = Log.create({ service: "engineer-stderr" })
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  const emit = (line: string) => {
    if (line.length === 0) return
    stderrLog.warn("engineer stderr", { engineerID, line })
  }
  return {
    write(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx = buffer.indexOf("\n")
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "")
        emit(line)
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf("\n")
      }
    },
    flush() {
      buffer += decoder.decode()
      if (buffer.length > 0) {
        emit(buffer.replace(/\r$/, ""))
        buffer = ""
      }
    },
  }
}

export * as EngineerEventReader from "./engineer-event-reader"
