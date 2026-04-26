/**
 * progressDisplayController — pure, framework-agnostic dwell-queue for
 * engineer progress text.
 *
 * Problem: progressText events can arrive faster than the human eye can read
 * them (~10 ms apart). We want each distinct text to be shown for at least
 * MIN_DWELL_MS before being replaced.
 *
 * Algorithm per-engineer:
 *   - currentText / lastShownAt track what is displayed right now.
 *   - When a new text arrives:
 *       • If the dwell window has elapsed → show immediately, reset lastShownAt.
 *       • Otherwise → queue it (only the latest matters; older queued values
 *         are discarded) and schedule a timeout for the remaining dwell time.
 *   - On timeout: swap queued → current, notify onChange, clear queue.
 *   - dispose() clears any pending timeout (call when the engineer slot is removed).
 *
 * Usage:
 *   const ctrl = progressDisplayController("initial text", onChange)
 *   ctrl.push("new text")          // drive from reactive layer
 *   ctrl.getCurrent()              // read displayed text
 *   ctrl.getUpdatedAt()            // timestamp of last display change
 *   ctrl.dispose()                 // cleanup on unmount
 */

export const MIN_DWELL_MS = 600

export interface ProgressDisplayController {
  push(text: string | undefined): void
  getCurrent(): string | undefined
  getUpdatedAt(): number
  dispose(): void
}

export function progressDisplayController(
  initialText: string | undefined,
  onChange: (text: string | undefined, updatedAt: number) => void,
): ProgressDisplayController {
  let currentText: string | undefined = initialText
  let lastShownAt: number = initialText !== undefined ? Date.now() : 0
  let queued: string | undefined = undefined
  let timer: ReturnType<typeof setTimeout> | undefined = undefined

  function flush() {
    timer = undefined
    if (queued === undefined) return
    currentText = queued
    lastShownAt = Date.now()
    queued = undefined
    onChange(currentText, lastShownAt)
  }

  function push(text: string | undefined) {
    const now = Date.now()
    const elapsed = now - lastShownAt

    if (elapsed >= MIN_DWELL_MS || lastShownAt === 0) {
      // Show immediately
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      queued = undefined
      currentText = text
      lastShownAt = now
      onChange(currentText, lastShownAt)
    } else {
      // Queue and schedule flush for the remaining dwell time
      queued = text
      if (timer === undefined) {
        const remaining = MIN_DWELL_MS - elapsed
        timer = setTimeout(flush, remaining)
      }
      // If a timer is already scheduled we just updated `queued` in place;
      // the existing timer will pick it up when it fires.
    }
  }

  function getCurrent(): string | undefined {
    return currentText
  }

  function getUpdatedAt(): number {
    return lastShownAt
  }

  function dispose() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return { push, getCurrent, getUpdatedAt, dispose }
}
