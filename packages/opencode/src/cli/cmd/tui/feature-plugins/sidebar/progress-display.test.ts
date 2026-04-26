/**
 * Unit tests for progressDisplayController (progress-display.ts).
 *
 * The controller is a pure TS module with no framework dependencies, so we can
 * test it directly in bun:test.
 *
 * Coverage:
 *   1. First push with no prior text shows immediately (lastShownAt=0 path).
 *   2. Push within dwell window → queued, not shown immediately.
 *   3. After dwell expires → queued text is shown (flush callback fires).
 *   4. Multiple rapid pushes → only the latest queued text is shown.
 *   5. Push after dwell elapsed → shown immediately, no timer.
 *   6. dispose() prevents flush callback from firing.
 *   7. getCurrent() and getUpdatedAt() return correct values.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { progressDisplayController, MIN_DWELL_MS } from "./progress-display"

// ---------------------------------------------------------------------------
// Fake timers — bun:test uses `mock.timers` (globalThis.setTimeout replacement)
// We stub Date.now manually so we can control time independently of timers.
// ---------------------------------------------------------------------------

let fakeNow = 0
const realDateNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

// Minimal fake timer queue
interface FakeTimer {
  id: number
  at: number
  fn: () => void
  cancelled: boolean
}

let timerQueue: FakeTimer[] = []
let timerIdCounter = 0

function fakeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const id = ++timerIdCounter
  timerQueue.push({ id, at: fakeNow + ms, fn, cancelled: false })
  return id as unknown as ReturnType<typeof setTimeout>
}

function fakeClearTimeout(id: ReturnType<typeof setTimeout>) {
  const t = timerQueue.find((t) => t.id === (id as unknown as number))
  if (t) t.cancelled = true
}

function advanceTime(ms: number) {
  fakeNow += ms
  const due = timerQueue.filter((t) => !t.cancelled && t.at <= fakeNow)
  timerQueue = timerQueue.filter((t) => t.cancelled || t.at > fakeNow)
  for (const t of due) {
    t.fn()
  }
}

beforeEach(() => {
  fakeNow = 1_000_000 // start at a non-zero time so lastShownAt=0 is detectable
  timerQueue = []
  timerIdCounter = 0
  // Inject fakes
  Date.now = () => fakeNow
  ;(globalThis as unknown as Record<string, unknown>).setTimeout = fakeSetTimeout
  ;(globalThis as unknown as Record<string, unknown>).clearTimeout = fakeClearTimeout
})

afterEach(() => {
  Date.now = realDateNow
  ;(globalThis as unknown as Record<string, unknown>).setTimeout = realSetTimeout
  ;(globalThis as unknown as Record<string, unknown>).clearTimeout = realClearTimeout
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("progressDisplayController", () => {
  test("push with lastShownAt=0 shows immediately", () => {
    const calls: Array<{ text: string | undefined; at: number }> = []
    const ctrl = progressDisplayController(undefined, (text, at) => calls.push({ text, at }))

    expect(ctrl.getCurrent()).toBeUndefined()
    expect(ctrl.getUpdatedAt()).toBe(0)

    ctrl.push("Thinking...")
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe("Thinking...")
    expect(ctrl.getCurrent()).toBe("Thinking...")
    expect(ctrl.getUpdatedAt()).toBe(fakeNow)
  })

  test("initialText sets current and lastShownAt", () => {
    const ctrl = progressDisplayController("init", () => {})
    expect(ctrl.getCurrent()).toBe("init")
    expect(ctrl.getUpdatedAt()).toBeGreaterThan(0)
  })

  test("push within dwell window queues, does not call onChange immediately", () => {
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("A")           // immediately (lastShownAt=0)
    expect(calls).toEqual(["A"])

    advanceTime(100)          // only 100 ms elapsed (< MIN_DWELL_MS=600)
    ctrl.push("B")
    expect(calls).toHaveLength(1)  // not shown yet
    expect(ctrl.getCurrent()).toBe("A")
  })

  test("after dwell expires, queued text is shown via setTimeout callback", () => {
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("A")
    advanceTime(100)
    ctrl.push("B")
    expect(calls).toHaveLength(1)

    // Advance past dwell window; the timer scheduled for (MIN_DWELL_MS - 100) fires
    advanceTime(MIN_DWELL_MS - 100)
    expect(calls).toEqual(["A", "B"])
    expect(ctrl.getCurrent()).toBe("B")
  })

  test("multiple rapid pushes within dwell: only the latest queued text is shown", () => {
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("A")
    advanceTime(50)
    ctrl.push("B")  // queued
    advanceTime(50)
    ctrl.push("C")  // replaces B in queue (only one timer outstanding)
    advanceTime(50)
    ctrl.push("D")  // replaces C

    // still showing A
    expect(ctrl.getCurrent()).toBe("A")

    // fire the timer
    advanceTime(MIN_DWELL_MS)
    expect(calls).toEqual(["A", "D"])
    expect(ctrl.getCurrent()).toBe("D")
  })

  test("push after full dwell shows immediately with no timer", () => {
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("A")
    advanceTime(MIN_DWELL_MS + 1)
    ctrl.push("B")

    expect(calls).toEqual(["A", "B"])
    expect(timerQueue.filter((t) => !t.cancelled)).toHaveLength(0)
  })

  test("dispose cancels pending timer so flush does not fire", () => {
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("A")
    advanceTime(100)
    ctrl.push("B")
    ctrl.dispose()

    advanceTime(MIN_DWELL_MS)
    // flush should NOT have fired
    expect(calls).toEqual(["A"])
    expect(ctrl.getCurrent()).toBe("A")
  })

  test("getUpdatedAt updates on each visible change", () => {
    const ctrl = progressDisplayController(undefined, () => {})

    ctrl.push("A")
    const t1 = ctrl.getUpdatedAt()
    advanceTime(MIN_DWELL_MS + 1)
    ctrl.push("B")
    const t2 = ctrl.getUpdatedAt()

    expect(t2).toBeGreaterThan(t1)
  })

  test("duplicate push of currentText does not refresh updatedAt", () => {
    // Reactive layer (Solid createEffect) re-runs whenever any tracked
    // slot field changes. The controller must ignore pushes where the
    // text matches what is already displayed — otherwise unrelated
    // state changes would refresh `lastShownAt` and re-trigger the
    // recency-based spinner for an engineer that has not actually made
    // any progress.
    const calls: string[] = []
    const ctrl = progressDisplayController(undefined, (t) => calls.push(t ?? ""))

    ctrl.push("Thinking...")
    const initialUpdatedAt = ctrl.getUpdatedAt()

    advanceTime(MIN_DWELL_MS + 5000) // way past the dwell window
    ctrl.push("Thinking...") // duplicate — should be ignored

    expect(calls).toEqual(["Thinking..."]) // onChange fired only once
    expect(ctrl.getUpdatedAt()).toBe(initialUpdatedAt) // timestamp not refreshed
  })
})
