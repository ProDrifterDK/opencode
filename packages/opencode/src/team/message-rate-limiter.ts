import { MESSAGE_RATE_LIMIT_PER_MIN, MESSAGE_RATE_WINDOW_MS } from "./constants"

const senderTimestamps = new Map<string, number[]>()

export function checkAndRecordMessage(
  senderID: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs?: number } {
  const cutoff = now - MESSAGE_RATE_WINDOW_MS
  const ts = (senderTimestamps.get(senderID) ?? []).filter((t) => t > cutoff)
  if (ts.length >= MESSAGE_RATE_LIMIT_PER_MIN) {
    senderTimestamps.set(senderID, ts) // store pruned
    const oldest = ts[0]
    return { allowed: false, retryAfterMs: oldest + MESSAGE_RATE_WINDOW_MS - now }
  }
  ts.push(now)
  senderTimestamps.set(senderID, ts)
  return { allowed: true }
}

/** Reset all rate-limit state. For use in tests only. */
export function _resetRateLimiter(): void {
  senderTimestamps.clear()
}
