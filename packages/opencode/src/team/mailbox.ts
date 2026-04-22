import { eq, and, asc, isNull, sql } from "drizzle-orm"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database } from "@/storage"
import { Effect, Layer, Context } from "effect"
import { SessionID } from "../session/schema"
import { MailboxTable, type MailboxID, type MailboxPriority, type MailboxRow } from "./mailbox.sql"
import { MAILBOX_QUEUE_DEPTH } from "./constants"

export const Event = {
  Received: BusEvent.define(
    "mailbox.message.received",
    z.object({
      messageID: z.string(),
      recipientSessionID: z.string(),
      priority: z.enum(["urgent", "inbox", "queue"]),
    }),
  ),
  Read: BusEvent.define(
    "mailbox.message.read",
    z.object({
      messageID: z.string(),
      recipientSessionID: z.string(),
    }),
  ),
  EngineerMessageSent: BusEvent.define(
    "team.engineer.message_sent",
    z.object({
      messageID: z.string(),
      senderSessionID: z.string(),
      recipientSessionID: z.string(),
      priority: z.enum(["urgent", "inbox", "queue"]),
    }),
  ),
  LeadMessageReceived: BusEvent.define(
    "team.lead.message_received",
    z.object({
      messageID: z.string(),
      leadSessionID: z.string(),
      senderSessionID: z.string(),
      priority: z.enum(["urgent", "inbox", "queue"]),
    }),
  ),
}

export interface Interface {
  readonly send: (input: {
    recipientSessionID: SessionID
    senderSessionID: SessionID
    priority: MailboxPriority
    type: string
    content: string
  }) => Effect.Effect<MailboxRow>
  readonly receive: (recipientSessionID: SessionID) => Effect.Effect<MailboxRow[]>
  readonly receiveByPriority: (input: {
    recipientSessionID: SessionID
    priority: MailboxPriority
  }) => Effect.Effect<MailboxRow[]>
  readonly peek: (recipientSessionID: SessionID) => Effect.Effect<MailboxRow[]>
  readonly markRead: (input: { messageID: MailboxID; recipientSessionID: SessionID }) => Effect.Effect<void>
  readonly purge: (recipientSessionID: SessionID) => Effect.Effect<void>
  readonly hasUnread: (input: {
    recipientSessionID: SessionID
    priority?: MailboxPriority
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Mailbox") {}

type DbClient = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never

type NotPromise<T> = T extends Promise<any> ? never : T

function dbQuery<A>(f: (db: DbClient) => NotPromise<A>) {
  return Effect.try({ try: () => Database.use(f), catch: (cause) => new Error(String(cause)) }).pipe(Effect.orDie)
}

function dbTx<A>(f: (db: DbClient) => NotPromise<A>) {
  return Effect.try({ try: () => Database.transaction(f), catch: (cause) => new Error(String(cause)) }).pipe(Effect.orDie)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const enforceDepthLimit = (recipientSessionID: SessionID) =>
      dbTx((db) => {
        const count = db
          .select({ value: sql<number>`count(*)` })
          .from(MailboxTable)
          .where(eq(MailboxTable.recipient_session_id, recipientSessionID))
          .get()

        if (count && count.value > MAILBOX_QUEUE_DEPTH) {
          const overflow = count.value - MAILBOX_QUEUE_DEPTH
          const oldest = db
            .select({ id: MailboxTable.id })
            .from(MailboxTable)
            .where(eq(MailboxTable.recipient_session_id, recipientSessionID))
            .orderBy(asc(MailboxTable.created_at))
            .limit(overflow)
            .all()

          for (const row of oldest) {
            db.delete(MailboxTable).where(eq(MailboxTable.id, row.id)).run()
          }
        }
      })

    const send = Effect.fn("Mailbox.send")(function* (input: {
      recipientSessionID: SessionID
      senderSessionID: SessionID
      priority: MailboxPriority
      type: string
      content: string
    }) {
      const id = crypto.randomUUID() as MailboxID
      const now = Date.now()
      const row: MailboxRow = {
        id,
        recipient_session_id: input.recipientSessionID,
        sender_session_id: input.senderSessionID,
        priority: input.priority,
        type: input.type,
        content: input.content,
        created_at: now,
        read_at: null,
      }

      yield* dbTx((db) => {
        db.insert(MailboxTable).values(row).run()
      })

      yield* enforceDepthLimit(input.recipientSessionID)

      yield* bus.publish(Event.Received, {
        messageID: id,
        recipientSessionID: input.recipientSessionID,
        priority: input.priority,
      })

      yield* bus.publish(Event.EngineerMessageSent, {
        messageID: id,
        senderSessionID: input.senderSessionID,
        recipientSessionID: input.recipientSessionID,
        priority: input.priority,
      })

      yield* bus.publish(Event.LeadMessageReceived, {
        messageID: id,
        leadSessionID: input.recipientSessionID,
        senderSessionID: input.senderSessionID,
        priority: input.priority,
      })

      return row
    })

    const receive = Effect.fn("Mailbox.receive")(function* (recipientSessionID: SessionID) {
      return yield* dbQuery((db) =>
        db
          .select()
          .from(MailboxTable)
          .where(
            and(
              eq(MailboxTable.recipient_session_id, recipientSessionID),
              isNull(MailboxTable.read_at),
            ),
          )
          .orderBy(
            sql`CASE ${MailboxTable.priority}
              WHEN 'urgent' THEN 0
              WHEN 'inbox' THEN 1
              WHEN 'queue' THEN 2
              ELSE 3
            END`,
            asc(MailboxTable.created_at),
          )
          .all() as MailboxRow[],
      )
    })

    const peek = Effect.fn("Mailbox.peek")(function* (recipientSessionID: SessionID) {
      return yield* dbQuery((db) =>
        db
          .select()
          .from(MailboxTable)
          .where(eq(MailboxTable.recipient_session_id, recipientSessionID))
          .orderBy(
            sql`CASE ${MailboxTable.priority}
              WHEN 'urgent' THEN 0
              WHEN 'inbox' THEN 1
              WHEN 'queue' THEN 2
              ELSE 3
            END`,
            asc(MailboxTable.created_at),
          )
          .all() as MailboxRow[],
      )
    })

    const receiveByPriority = Effect.fn("Mailbox.receiveByPriority")(function* (input: {
      recipientSessionID: SessionID
      priority: MailboxPriority
    }) {
      return yield* dbQuery((db) =>
        db
          .select()
          .from(MailboxTable)
          .where(
            and(
              eq(MailboxTable.recipient_session_id, input.recipientSessionID),
              eq(MailboxTable.priority, input.priority),
              isNull(MailboxTable.read_at),
            ),
          )
          .orderBy(asc(MailboxTable.created_at))
          .all() as MailboxRow[],
      )
    })

    const hasUnread = Effect.fn("Mailbox.hasUnread")(function* (input: {
      recipientSessionID: SessionID
      priority?: MailboxPriority
    }) {
      return yield* dbQuery((db) => {
        const conditions = [
          eq(MailboxTable.recipient_session_id, input.recipientSessionID),
          isNull(MailboxTable.read_at),
        ]
        if (input.priority) conditions.push(eq(MailboxTable.priority, input.priority))
        const row = db
          .select({ value: sql<number>`count(*)` })
          .from(MailboxTable)
          .where(and(...conditions))
          .get()
        return (row?.value ?? 0) > 0
      })
    })

    const markRead = Effect.fn("Mailbox.markRead")(function* (input: {
      messageID: MailboxID
      recipientSessionID: SessionID
    }) {
      yield* dbTx((db) => {
        db.update(MailboxTable)
          .set({ read_at: Date.now() })
          .where(
            and(
              eq(MailboxTable.id, input.messageID),
              eq(MailboxTable.recipient_session_id, input.recipientSessionID),
            ),
          )
          .run()
      })

      yield* bus.publish(Event.Read, {
        messageID: input.messageID,
        recipientSessionID: input.recipientSessionID,
      })
    })

    const purge = Effect.fn("Mailbox.purge")(function* (recipientSessionID: SessionID) {
      yield* dbTx((db) => {
        db.delete(MailboxTable)
          .where(eq(MailboxTable.recipient_session_id, recipientSessionID))
          .run()
      })
    })

    return Service.of({ send, receive, receiveByPriority, peek, markRead, purge, hasUnread })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Mailbox from "./mailbox"
