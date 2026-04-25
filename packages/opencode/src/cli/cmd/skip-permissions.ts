/**
 * skip-permissions — auto-replier helper for `--dangerously-skip-permissions`.
 *
 * Subscribes to the event stream and, for every `permission.asked` event
 * whose sessionID matches the given session, immediately replies "once".
 * This allows unattended engineer subprocesses to run without deadlocking
 * on permission prompts.
 *
 * Usage:
 *   const ac = new AbortController()
 *   const replierDone = runPermissionAutoReplier(sdk, sessionID, ac.signal)
 *   await runEngineerLoop(...)   // or any other work
 *   ac.abort()
 *   await replierDone
 */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

const MAX_SUBSCRIBE_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 100

/**
 * Sentinel returned by abortRace to indicate the signal fired.
 */
const ABORTED = Symbol("ABORTED")

/**
 * Races an async iterator against an AbortSignal.
 * Yields each value from the iterator, but returns early (without throwing)
 * if the signal is aborted while the iterator is parked awaiting the next value.
 */
async function* abortableStream<T>(
  iter: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = (iter as AsyncIterableIterator<T>)[Symbol.asyncIterator]()

  // A promise that resolves to ABORTED when the signal fires
  let abortResolve!: () => void
  const abortPromise = new Promise<typeof ABORTED>((resolve) => {
    abortResolve = () => resolve(ABORTED)
    if (signal.aborted) {
      resolve(ABORTED)
    } else {
      signal.addEventListener("abort", abortResolve, { once: true })
    }
  })

  try {
    while (true) {
      // Race the next iterator value against abort
      const result = await Promise.race([iterator.next(), abortPromise])

      if (result === ABORTED) {
        // Signal fired while we were parked — exit cleanly
        break
      }

      const { value, done } = result as IteratorResult<T>
      if (done) break
      yield value
    }
  } finally {
    signal.removeEventListener("abort", abortResolve)
    // Best-effort cleanup: fire-and-forget. Do NOT await — the underlying
    // generator may be parked on a never-resolving internal Promise, which
    // would make iterator.return()'s Promise also never resolve, hanging us.
    iterator.return?.(undefined)?.catch(() => {})
  }
}

/**
 * runPermissionAutoReplier
 *
 * Starts a background loop that auto-replies "once" to every
 * `permission.asked` event for the given sessionID.
 *
 * Robustness:
 *  - Issue 1: Abort signal is raced against each iterator.next() call so the
 *    loop exits promptly even when parked awaiting the next event chunk.
 *  - Issue 2: sdk.event.subscribe is retried with exponential backoff (up to 5
 *    attempts) so transient startup failures don't permanently disarm the replier.
 *  - Issue 3: sdk.permission.reply failures are caught per-event so the loop
 *    survives a single failed reply and continues handling subsequent events.
 *
 * @param sdk       An already-connected OpencodeClient
 * @param sessionID Only reply to permission requests for this session
 * @param signal    Abort signal; cancels the loop when aborted
 * @returns         A promise that resolves when the loop exits (either
 *                  because the signal was aborted or the stream ended)
 */
export async function runPermissionAutoReplier(
  sdk: OpencodeClient,
  sessionID: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return

  // Issue 2: retry subscribe with exponential backoff
  let events: { stream: AsyncIterable<any> } | null = null
  let backoffMs = INITIAL_BACKOFF_MS

  for (let attempt = 1; attempt <= MAX_SUBSCRIBE_ATTEMPTS; attempt++) {
    if (signal.aborted) return
    try {
      events = await (sdk.event.subscribe as Function)()
      break
    } catch (err) {
      process.stderr.write(
        `[skip-permissions] subscribe failed (attempt ${attempt}/${MAX_SUBSCRIBE_ATTEMPTS}): ${err}\n`,
      )
      if (attempt === MAX_SUBSCRIBE_ATTEMPTS) {
        process.stderr.write(
          `[skip-permissions] all subscribe attempts exhausted — auto-replier disabled\n`,
        )
        return
      }
      // Wait with backoff, abort cleanly if signal fires during the wait
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      backoffMs = Math.min(backoffMs * 2, 1600)
    }
  }

  if (!events || signal.aborted) return

  // Issue 1: use abortableStream so the for-await exits promptly on signal,
  // even when parked awaiting the next event.
  for await (const event of abortableStream(events.stream, signal)) {
    if (event.type === "permission.asked") {
      const permission = event.properties
      if (permission.sessionID !== sessionID) continue

      // Issue 3: wrap reply in try/catch so a single failure doesn't kill the loop
      try {
        await sdk.permission.reply({
          requestID: permission.id,
          reply: "once",
        })
      } catch (err) {
        process.stderr.write(
          `[skip-permissions] reply failed for request ${permission.id}: ${err}\n`,
        )
        continue
      }
    }
  }
}
