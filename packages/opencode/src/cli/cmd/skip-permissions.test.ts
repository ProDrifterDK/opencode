import { describe, expect, test } from "bun:test"
import { runPermissionAutoReplier } from "./skip-permissions"

// Minimal mock of an OpencodeClient sufficient to test the auto-replier.
// We only need event.subscribe() and permission.reply().
function createMockSdk(events: Array<{ type: string; properties: Record<string, unknown> }>) {
  const replies: Array<{ requestID: string; reply: string }> = []

  async function* makeStream() {
    for (const event of events) {
      yield event
    }
  }

  const sdk = {
    event: {
      subscribe: async () => ({ stream: makeStream() }),
    },
    permission: {
      reply: async (input: { requestID: string; reply: string }) => {
        replies.push(input)
      },
    },
  } as any

  return { sdk, replies }
}

describe("runPermissionAutoReplier", () => {
  test("replies once to permission.asked for the correct session", async () => {
    const sessionID = "ses_engineer_001"
    const { sdk, replies } = createMockSdk([
      {
        type: "permission.asked",
        properties: {
          id: "req_abc",
          sessionID,
          permission: "bash",
          patterns: ["*"],
        },
      },
    ])

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ requestID: "req_abc", reply: "once" })
  })

  test("ignores permission.asked events for a different session", async () => {
    const sessionID = "ses_engineer_001"
    const otherSessionID = "ses_other_002"
    const { sdk, replies } = createMockSdk([
      {
        type: "permission.asked",
        properties: {
          id: "req_other",
          sessionID: otherSessionID,
          permission: "bash",
          patterns: ["*"],
        },
      },
    ])

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    expect(replies).toHaveLength(0)
  })

  test("ignores non-permission events", async () => {
    const sessionID = "ses_engineer_001"
    const { sdk, replies } = createMockSdk([
      {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      },
      {
        type: "message.updated",
        properties: { sessionID, info: { role: "assistant" } },
      },
    ])

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    expect(replies).toHaveLength(0)
  })

  test("stops processing when signal is aborted", async () => {
    const sessionID = "ses_engineer_001"
    const replies: Array<{ requestID: string; reply: string }> = []

    // Infinite async generator that yields permission events
    async function* infiniteStream() {
      let i = 0
      while (true) {
        yield {
          type: "permission.asked",
          properties: {
            id: `req_${i++}`,
            sessionID,
            permission: "bash",
            patterns: ["*"],
          },
        }
        // Yield control so the abort can be processed
        await new Promise((r) => setTimeout(r, 0))
      }
    }

    const sdk = {
      event: {
        subscribe: async () => ({ stream: infiniteStream() }),
      },
      permission: {
        reply: async (input: { requestID: string; reply: string }) => {
          replies.push(input)
        },
      },
    } as any

    const ac = new AbortController()
    // Abort after a short tick — replier should stop soon after
    const replierPromise = runPermissionAutoReplier(sdk, sessionID, ac.signal)
    ac.abort()
    await replierPromise

    // We may have gotten 0 or 1 replies before abort was checked, but not many
    expect(replies.length).toBeLessThanOrEqual(2)
  })

  test("replies to multiple permission.asked events for the same session", async () => {
    const sessionID = "ses_engineer_001"
    const { sdk, replies } = createMockSdk([
      {
        type: "permission.asked",
        properties: { id: "req_1", sessionID, permission: "bash", patterns: ["*"] },
      },
      {
        type: "permission.asked",
        properties: { id: "req_2", sessionID, permission: "write", patterns: ["/tmp/**"] },
      },
      {
        type: "permission.asked",
        properties: {
          id: "req_other",
          sessionID: "ses_other",
          permission: "bash",
          patterns: ["*"],
        },
      },
    ])

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    expect(replies).toHaveLength(2)
    expect(replies[0]).toEqual({ requestID: "req_1", reply: "once" })
    expect(replies[1]).toEqual({ requestID: "req_2", reply: "once" })
  })

  // --- Issue 1: abort while parked on the next event ---
  test("resolves promptly when abort fires while awaiting next event", async () => {
    const sessionID = "ses_engineer_001"

    // A stream that signals when it has parked, then waits forever.
    // We abort only after the stream confirms it is parked, guaranteeing
    // the for-await is blocked on iterator.next() when abort fires.
    let resolveParked!: () => void
    const parkedPromise = new Promise<void>((r) => {
      resolveParked = r
    })

    async function* parkingStream() {
      // Signal that we've entered the generator and are about to park
      resolveParked()
      // Park indefinitely
      await new Promise<void>(() => {})
    }

    const sdk = {
      event: {
        subscribe: async () => ({ stream: parkingStream() }),
      },
      permission: {
        reply: async (_: any) => {},
      },
    } as any

    const ac = new AbortController()
    const replierPromise = runPermissionAutoReplier(sdk, sessionID, ac.signal)

    // Wait until the generator has confirmed it is parked
    await parkedPromise

    // Abort — the replier must resolve without waiting for a new event
    ac.abort()

    const raceResult = await Promise.race([
      replierPromise.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 100)),
    ])

    expect(raceResult).toBe("resolved")
  })

  // --- Issue 2: subscribe rejects first, succeeds on second attempt ---
  test("retries subscribe on failure and still replies on a subsequent event", async () => {
    const sessionID = "ses_engineer_001"
    const replies: Array<{ requestID: string; reply: string }> = []

    let subscribeCallCount = 0

    async function* goodStream() {
      yield {
        type: "permission.asked",
        properties: { id: "req_retry", sessionID, permission: "bash", patterns: ["*"] },
      }
    }

    const sdk = {
      event: {
        subscribe: async () => {
          subscribeCallCount++
          if (subscribeCallCount === 1) {
            throw new Error("server not ready")
          }
          return { stream: goodStream() }
        },
      },
      permission: {
        reply: async (input: { requestID: string; reply: string }) => {
          replies.push(input)
        },
      },
    } as any

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    expect(subscribeCallCount).toBeGreaterThanOrEqual(2)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ requestID: "req_retry", reply: "once" })
  })

  // --- Issue 3: reply failure doesn't kill the loop ---
  test("continues processing after a failed reply", async () => {
    const sessionID = "ses_engineer_001"
    const replyAttempts: string[] = []

    async function* twoEventStream() {
      yield {
        type: "permission.asked",
        properties: { id: "req_fail", sessionID, permission: "bash", patterns: ["*"] },
      }
      yield {
        type: "permission.asked",
        properties: { id: "req_ok", sessionID, permission: "write", patterns: ["/tmp/**"] },
      }
    }

    const sdk = {
      event: {
        subscribe: async () => ({ stream: twoEventStream() }),
      },
      permission: {
        reply: async (input: { requestID: string; reply: string }) => {
          replyAttempts.push(input.requestID)
          if (input.requestID === "req_fail") {
            throw new Error("404 request expired")
          }
        },
      },
    } as any

    const ac = new AbortController()
    await runPermissionAutoReplier(sdk, sessionID, ac.signal)

    // Both events were attempted despite the first throwing
    expect(replyAttempts).toHaveLength(2)
    expect(replyAttempts[0]).toBe("req_fail")
    expect(replyAttempts[1]).toBe("req_ok")
  })
})
