import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { LEAD_CONTEXT_BUDGET } from "./constants"
import type { MailboxRow, MessageBatch } from "./mailbox.sql"
import { Mailbox } from "./mailbox"
import { SessionID } from "@/session/schema"
import { Log } from "@/util"

const log = Log.create({ service: "team.message-summarizer" })

export const Event = {
  Summarized: BusEvent.define(
    "message-summarizer.summarized",
    Schema.Struct({
      sessionID: Schema.String,
      originalCount: Schema.Number,
      summaryCount: Schema.Number,
      preservedUrgent: Schema.Number,
    }),
  ),
}

export class SummarizerError extends Schema.TaggedErrorClass<SummarizerError>()(
  "SummarizerError",
  { message: Schema.String },
) {}

export type SummarizerConfig = {
  readonly triggerThreshold: number
  readonly contextBudget: number
}

export const DEFAULT_CONFIG: SummarizerConfig = {
  triggerThreshold: 10,
  contextBudget: LEAD_CONTEXT_BUDGET,
}

export type SummaryResult = {
  readonly summaryContent: string
  readonly batchedCount: number
  readonly preservedUrgent: MailboxRow[]
  readonly timestamp: number
}

export type Interface = {
  readonly shouldSummarize: (input: {
    sessionID: SessionID
    config?: Partial<SummarizerConfig>
  }) => Effect.Effect<boolean, never, Mailbox.Service>
  readonly batchByType: (messages: MailboxRow[]) => MessageBatch[]
  readonly summarize: (input: {
    sessionID: SessionID
    config?: Partial<SummarizerConfig>
    summarizeFn?: (batched: ReadonlyArray<MessageBatch>) => Effect.Effect<string, SummarizerError>
  }) => Effect.Effect<SummaryResult, SummarizerError, Mailbox.Service | Bus.Service>
  readonly replaceWithSummary: (input: {
    sessionID: SessionID
    result: SummaryResult
  }) => Effect.Effect<void, never, Mailbox.Service>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/MessageSummarizer",
) {}

export const defaultSummarizeFn = (batched: ReadonlyArray<MessageBatch>): Effect.Effect<string, SummarizerError> =>
  Effect.sync(() => {
    const parts = batched.map((batch) => {
      const msgs = batch.messages
        .map((m) => `[${m.priority}] ${m.content}`)
        .join("\n")
      return `## ${batch.type} (${msgs.length} messages)\n${msgs}`
    })
    return `Summary of ${batched.reduce((acc, b) => acc + b.messages.length, 0)} messages:\n\n${parts.join("\n\n")}`
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const shouldSummarize = Effect.fn("MessageSummarizer.shouldSummarize")(
      function* (input: {
        sessionID: SessionID
        config?: Partial<SummarizerConfig>
      }) {
        const threshold = input.config?.triggerThreshold ?? DEFAULT_CONFIG.triggerThreshold
        const mailbox = yield* Mailbox.Service
        const messages = yield* mailbox.peek(input.sessionID).pipe(Effect.orDie)
        return messages.length >= threshold
      },
    )

    const batchByType = (messages: MailboxRow[]): MessageBatch[] => {
      const groups = new Map<string, MailboxRow[]>()
      for (const msg of messages) {
        const existing = groups.get(msg.type)
        if (existing) {
          existing.push(msg)
        } else {
          groups.set(msg.type, [msg])
        }
      }
      return [...groups.entries()].map(([type, messages]) => ({ type, messages }))
    }

    const summarize = Effect.fnUntraced(
      function* (input: {
        sessionID: SessionID
        config?: Partial<SummarizerConfig>
        summarizeFn?: (batched: ReadonlyArray<MessageBatch>) => Effect.Effect<string, SummarizerError>
      }) {
        const mailbox = yield* Mailbox.Service
        const messages = yield* mailbox.peek(input.sessionID).pipe(Effect.orDie)

        const urgent = messages.filter((m) => m.priority === "urgent")
        const summarizable = messages.filter((m) => m.priority !== "urgent")

        if (summarizable.length === 0) {
          return {
            summaryContent: "",
            batchedCount: 0,
            preservedUrgent: urgent,
            timestamp: Date.now(),
          }
        }

        const batched = batchByType(summarizable)
        const fn = input.summarizeFn ?? defaultSummarizeFn
        const summaryContent = yield* fn(batched)

        const result: SummaryResult = {
          summaryContent,
          batchedCount: summarizable.length,
          preservedUrgent: urgent,
          timestamp: Date.now(),
        }

        log.info("summarized", {
          sessionID: input.sessionID,
          originalCount: messages.length,
          batchedCount: result.batchedCount,
          preservedUrgent: urgent.length,
        })

        yield* bus.publish(Event.Summarized, {
          sessionID: input.sessionID,
          originalCount: messages.length,
          summaryCount: 1,
          preservedUrgent: urgent.length,
        })

        return result
      },
    )

    const replaceWithSummary = Effect.fn("MessageSummarizer.replaceWithSummary")(
      function* (input: {
        sessionID: SessionID
        result: SummaryResult
      }) {
        const mailbox = yield* Mailbox.Service
        const { sessionID, result } = input

        yield* mailbox.purge(sessionID).pipe(Effect.orDie)

        if (result.summaryContent) {
          yield* mailbox.send({
            recipientSessionID: sessionID,
            senderSessionID: sessionID,
            priority: "queue",
            type: "summary",
            content: result.summaryContent,
          }).pipe(Effect.orDie)
        }

        for (const msg of result.preservedUrgent) {
          yield* mailbox.send({
            recipientSessionID: sessionID,
            senderSessionID: msg.sender_session_id,
            priority: msg.priority,
            type: msg.type,
            content: msg.content,
          }).pipe(Effect.orDie)
        }
      },
    )

    return Service.of({
      shouldSummarize,
      batchByType,
      summarize,
      replaceWithSummary,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
