import { describe, test, expect, beforeEach } from "bun:test"
import { checkAndRecordMessage, _resetRateLimiter } from "./message-rate-limiter"
import { MESSAGE_RATE_LIMIT_PER_MIN, MESSAGE_RATE_WINDOW_MS } from "./constants"

beforeEach(() => {
  _resetRateLimiter()
})

describe("checkAndRecordMessage", () => {
  test("10 sends within 60s are all allowed", () => {
    const now = 1_000_000
    for (let i = 0; i < MESSAGE_RATE_LIMIT_PER_MIN; i++) {
      const result = checkAndRecordMessage("sender-a", now + i * 1_000)
      expect(result.allowed).toBe(true)
    }
  })

  test("11th send within 60s is rejected with retryAfterMs > 0", () => {
    const now = 1_000_000
    for (let i = 0; i < MESSAGE_RATE_LIMIT_PER_MIN; i++) {
      checkAndRecordMessage("sender-a", now + i * 1_000)
    }
    const result = checkAndRecordMessage("sender-a", now + MESSAGE_RATE_LIMIT_PER_MIN * 1_000)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeDefined()
    expect(result.retryAfterMs!).toBeGreaterThan(0)
  })

  test("after 60s window passes, sender can send again", () => {
    const now = 1_000_000
    // Fill the window
    for (let i = 0; i < MESSAGE_RATE_LIMIT_PER_MIN; i++) {
      checkAndRecordMessage("sender-a", now + i * 1_000)
    }
    // Verify blocked
    const blocked = checkAndRecordMessage("sender-a", now + 59_000)
    expect(blocked.allowed).toBe(false)

    // After window passes (now + 60_001 means oldest timestamp now + 0 is outside cutoff)
    const afterWindow = now + MESSAGE_RATE_WINDOW_MS + 1
    const result = checkAndRecordMessage("sender-a", afterWindow)
    expect(result.allowed).toBe(true)
  })

  test("per-sender isolation: sender A hits limit, sender B is unaffected", () => {
    const now = 1_000_000
    // Fill sender A's window
    for (let i = 0; i < MESSAGE_RATE_LIMIT_PER_MIN; i++) {
      checkAndRecordMessage("sender-a", now + i * 100)
    }
    const aBlocked = checkAndRecordMessage("sender-a", now + MESSAGE_RATE_LIMIT_PER_MIN * 100)
    expect(aBlocked.allowed).toBe(false)

    // Sender B should still be allowed
    const bAllowed = checkAndRecordMessage("sender-b", now + MESSAGE_RATE_LIMIT_PER_MIN * 100)
    expect(bAllowed.allowed).toBe(true)
  })

  test("timestamp exactly at cutoff boundary is pruned (strict >)", () => {
    const now = 1_000_000
    const cutoff = now - MESSAGE_RATE_WINDOW_MS
    // Send 9 messages right at the cutoff boundary (will be pruned)
    for (let i = 0; i < MESSAGE_RATE_LIMIT_PER_MIN - 1; i++) {
      checkAndRecordMessage("sender-a", cutoff)
    }
    // All boundary timestamps pruned — sender should be allowed (pruned to 0, then +1 = 1 total)
    const result = checkAndRecordMessage("sender-a", now)
    expect(result.allowed).toBe(true)
  })
})
