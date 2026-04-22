import { describe, test, expect, beforeEach } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Service as MessageSummarizerService, defaultSummarizeFn, type MessageBatch } from "./message-summarizer"
import { Service as MailboxService } from "./mailbox"
import type { MailboxRow, MailboxID } from "./mailbox.sql"
import type { SessionID } from "@/session/schema"
import { Bus } from "@/bus"

// ─── Mock Mailbox ───────────────────────────────────────────────────────────

type MailboxState = { messages: MailboxRow[]; idCounter: number }

const makeMailboxState = (): MailboxState => ({ messages: [], idCounter: 0 })

const makeMailboxFromState = (state: MailboxState) => {
  const nextId = () => `mb_${++state.idCounter}` as MailboxID

  return MailboxService.of({
    send: (input: {
      recipientSessionID: SessionID
      senderSessionID: SessionID
      priority: MailboxRow["priority"]
      type: string
      content: string
    }) =>
      Effect.sync(() => {
        const row: MailboxRow = {
          id: nextId(),
          recipient_session_id: input.recipientSessionID,
          sender_session_id: input.senderSessionID,
          priority: input.priority,
          type: input.type,
          content: input.content,
          created_at: Date.now(),
          read_at: null,
        }
        state.messages.push(row)
        return row
      }),

    receive: (recipientSessionID: SessionID) =>
      Effect.sync(() =>
        state.messages.filter(
          (m) => m.recipient_session_id === recipientSessionID && m.read_at === null,
        ),
      ),

    peek: (recipientSessionID: SessionID) =>
      Effect.sync(() =>
        state.messages.filter((m) => m.recipient_session_id === recipientSessionID),
      ),

    markRead: (input: { messageID: MailboxID; recipientSessionID: SessionID }) =>
      Effect.sync(() => {
        const msg = state.messages.find((m) => m.id === input.messageID)
        if (msg) msg.read_at = Date.now()
      }),

    purge: (recipientSessionID: SessionID) =>
      Effect.sync(() => {
        state.messages = state.messages.filter((m) => m.recipient_session_id !== recipientSessionID)
      }),

    receiveByPriority: (input: { recipientSessionID: SessionID; priority: MailboxRow["priority"] }) =>
      Effect.sync(() =>
        state.messages.filter(
          (m) => m.recipient_session_id === input.recipientSessionID && m.priority === input.priority && m.read_at === null,
        ),
      ),

    hasUnread: (input: { recipientSessionID: SessionID; priority?: MailboxRow["priority"] }) =>
      Effect.sync(() =>
        state.messages.some(
          (m) => m.recipient_session_id === input.recipientSessionID && m.read_at === null && (input.priority ? m.priority === input.priority : true),
        ),
      ),
  })
}

// ─── Mock Bus ───────────────────────────────────────────────────────────────

const mockBusLayer = Layer.succeed(Bus.Service, Bus.Service.of({
  publish: () => Effect.void,
  subscribe: () => Stream.empty,
  subscribeAll: () => Stream.empty,
  subscribeCallback: () => Effect.sync(() => () => {}),
  subscribeAllCallback: () => Effect.sync(() => () => {}),
}))

// ─── Layer setup ────────────────────────────────────────────────────────────

const SESSION_ID = "session_lead_test" as SessionID

let currentState = makeMailboxState()

const getMailboxLayer = () => Layer.succeed(MailboxService, makeMailboxFromState(currentState))

import { layer as summarizerLayer } from "./message-summarizer"

const getResolvedLayer = () => {
  const summarizerWithBus = summarizerLayer.pipe(Layer.provide(mockBusLayer))
  return Layer.mergeAll(summarizerWithBus, getMailboxLayer())
}

const runWith = <A, R>(
  effect: Effect.Effect<A, any, R>,
) => Effect.provide(effect as Effect.Effect<A, any, never>, getResolvedLayer()).pipe(Effect.runPromise)

const runWithBoth = runWith

const addMessage = async (
  priority: MailboxRow["priority"],
  type: string,
  content: string,
) =>
  Effect.runPromise(
    makeMailboxFromState(currentState).send({
      recipientSessionID: SESSION_ID,
      senderSessionID: "sender_1" as SessionID,
      priority,
      type,
      content,
    }),
  )

const peekMessages = () =>
  Effect.runPromise(makeMailboxFromState(currentState).peek(SESSION_ID))

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeMessage = (
  type: string,
  priority: MailboxRow["priority"] = "inbox",
  content?: string,
): MailboxRow => ({
  id: `mb_${Math.random().toString(36).slice(2)}` as MailboxID,
  recipient_session_id: SESSION_ID,
  sender_session_id: "sender_1" as SessionID,
  priority,
  type,
  content: content ?? `${type} message at ${Date.now()}`,
  created_at: Date.now(),
  read_at: null,
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("MessageSummarizer", () => {
  beforeEach(() => {
    currentState = makeMailboxState()
  })

  test("shouldSummarize returns false below threshold", async () => {
    for (let i = 0; i < 5; i++) {
      await addMessage("inbox", "task-update", `Message ${i}`)
    }

    const result = await runWith(
      Effect.gen(function* () {
        const svc = yield* MessageSummarizerService
        return yield* svc.shouldSummarize({ sessionID: SESSION_ID })
      }),
    )

    expect(result).toBe(false)
  })

  test("shouldSummarize returns true at threshold", async () => {
    for (let i = 0; i < 10; i++) {
      await addMessage("inbox", "task-update", `Message ${i}`)
    }

    const result = await runWith(
      Effect.gen(function* () {
        const svc = yield* MessageSummarizerService
        return yield* svc.shouldSummarize({ sessionID: SESSION_ID })
      }),
    )

    expect(result).toBe(true)
  })

  test("shouldSummarize respects custom threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await addMessage("inbox", "task-update", `Message ${i}`)
    }

    const result = await runWith(
      Effect.gen(function* () {
        const svc = yield* MessageSummarizerService
        return yield* svc.shouldSummarize({ sessionID: SESSION_ID, config: { triggerThreshold: 3 } })
      }),
    )

    expect(result).toBe(true)
  })

  test("batchByType groups messages by type", async () => {
    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const messages = [
      makeMessage("task-update", "inbox"),
      makeMessage("task-update", "inbox"),
      makeMessage("status-report", "inbox"),
      makeMessage("blocker", "inbox"),
      makeMessage("status-report", "inbox"),
    ]

    const batches = svc.batchByType(messages)

    expect(batches).toHaveLength(3)
    const types = batches.map((b) => b.type).sort()
    expect(types).toEqual(["blocker", "status-report", "task-update"])

    const taskUpdate = batches.find((b) => b.type === "task-update")!
    expect(taskUpdate.messages).toHaveLength(2)

    const statusReport = batches.find((b) => b.type === "status-report")!
    expect(statusReport.messages).toHaveLength(2)

    const blocker = batches.find((b) => b.type === "blocker")!
    expect(blocker.messages).toHaveLength(1)
  })

  test("15 msgs → 1 summary, urgent preserved", async () => {
    for (let i = 0; i < 12; i++) {
      await addMessage("inbox", i < 6 ? "task-update" : "status-report", `Inbox message ${i}`)
    }
    for (let i = 0; i < 3; i++) {
      await addMessage("urgent", "blocker", `URGENT: Critical issue ${i}`)
    }

    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const result = await runWith(
      svc.summarize({ sessionID: SESSION_ID }),
    )

    expect(result.batchedCount).toBe(12)
    expect(result.preservedUrgent).toHaveLength(3)
    expect(result.summaryContent).toContain("task-update")
    expect(result.summaryContent).toContain("status-report")
    expect(result.summaryContent).toContain("12 messages")
  })

  test("urgent messages bypass summarization", async () => {
    for (let i = 0; i < 5; i++) {
      await addMessage("urgent", "blocker", `URGENT: Issue ${i}`)
    }

    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const result = await runWith(
      svc.summarize({ sessionID: SESSION_ID }),
    )

    expect(result.batchedCount).toBe(0)
    expect(result.preservedUrgent).toHaveLength(5)
    expect(result.summaryContent).toBe("")
  })

  test("replaceWithSummary replaces batched with summary and keeps urgent", async () => {
    for (let i = 0; i < 12; i++) {
      await addMessage("inbox", "task-update", `Message ${i}`)
    }
    for (let i = 0; i < 3; i++) {
      await addMessage("urgent", "blocker", `URGENT ${i}`)
    }

    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const result = await runWith(
      svc.summarize({ sessionID: SESSION_ID }),
    )

    await runWithBoth(
      svc.replaceWithSummary({ sessionID: SESSION_ID, result }),
    )

    const remaining = await peekMessages()

    expect(remaining).toHaveLength(4)

    const summaries = remaining.filter((m) => m.type === "summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0].priority).toBe("queue")

    const urgents = remaining.filter((m) => m.priority === "urgent")
    expect(urgents).toHaveLength(3)
  })

  test("defaultSummarizeFn produces valid summary from batches", async () => {
    const batches: MessageBatch[] = [
      {
        type: "task-update",
        messages: [
          { ...makeMessage("task-update", "inbox"), content: "Task A done" },
          { ...makeMessage("task-update", "inbox"), content: "Task B started" },
        ],
      },
      {
        type: "blocker",
        messages: [
          { ...makeMessage("blocker", "inbox"), content: "Blocked on auth" },
        ],
      },
    ]

    const summary = await Effect.runPromise(defaultSummarizeFn(batches))

    expect(summary).toContain("task-update")
    expect(summary).toContain("blocker")
    expect(summary).toContain("Task A done")
    expect(summary).toContain("3 messages")
  })

  test("custom summarizeFn is used when provided", async () => {
    for (let i = 0; i < 5; i++) {
      await addMessage("inbox", "task-update", `Message ${i}`)
    }

    const customFn = (batches: MessageBatch[]) =>
      Effect.sync(() => `CUSTOM: ${batches.length} batches`)

    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const result = await runWith(
      svc.summarize({ sessionID: SESSION_ID, summarizeFn: customFn }),
    )

    expect(result.summaryContent).toBe("CUSTOM: 1 batches")
    expect(result.batchedCount).toBe(5)
  })

  test("full flow: 15 msgs → summarize → replace", async () => {
    for (let i = 0; i < 12; i++) {
      await addMessage("inbox", i < 6 ? "task-update" : "status-report", `Inbox ${i}`)
    }
    for (let i = 0; i < 3; i++) {
      await addMessage("urgent", "blocker", `URGENT ${i}`)
    }

    const svc = await runWith(Effect.gen(function* () {
      return yield* MessageSummarizerService
    }))

    const shouldSummarize = await runWith(
      svc.shouldSummarize({ sessionID: SESSION_ID }),
    )
    expect(shouldSummarize).toBe(true)

    const result = await runWith(
      svc.summarize({ sessionID: SESSION_ID }),
    )
    expect(result.batchedCount).toBe(12)
    expect(result.preservedUrgent).toHaveLength(3)

    await runWithBoth(
      svc.replaceWithSummary({ sessionID: SESSION_ID, result }),
    )

    const final = await peekMessages()
    expect(final).toHaveLength(4)

    const summaryMsg = final.find((m) => m.type === "summary")!
    expect(summaryMsg).toBeDefined()
    expect(summaryMsg.content).toContain("task-update")
    expect(summaryMsg.content).toContain("status-report")
  })
})
