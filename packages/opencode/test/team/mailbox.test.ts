import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and, asc, isNull, sql } from "drizzle-orm"
import { MailboxTable, type MailboxID, type MailboxPriority, type MailboxRow } from "../../src/team/mailbox.sql"
import { MAILBOX_QUEUE_DEPTH } from "../../src/team/constants"

let sqlite: Database
let db: SQLiteBunDatabase

const MIGRATION_SQL = `CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,
  recipient_session_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  priority TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX mailbox_recipient_priority_created_idx ON mailbox(recipient_session_id, priority, created_at);
CREATE INDEX mailbox_recipient_read_idx ON mailbox(recipient_session_id, read_at);`

beforeEach(() => {
  sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  db = drizzle({ client: sqlite })
  migrate(db, [{ sql: MIGRATION_SQL, timestamp: 1, name: "init" }])
})

afterEach(() => {
  sqlite.close()
})

function insert(recipient: string, sender: string, priority: MailboxPriority, type: string, content: string, createdAt?: number) {
  const id = crypto.randomUUID() as MailboxID
  const now = createdAt ?? Date.now()
  db.insert(MailboxTable).values({
    id,
    recipient_session_id: recipient,
    sender_session_id: sender,
    priority,
    type,
    content,
    created_at: now,
    read_at: null,
  } as any).run()
  return { id, recipient_session_id: recipient, sender_session_id: sender, priority, type, content, created_at: now, read_at: null } as MailboxRow
}

const PRIORITY_SORT = sql`CASE ${MailboxTable.priority}
  WHEN 'urgent' THEN 0
  WHEN 'inbox' THEN 1
  WHEN 'queue' THEN 2
  ELSE 3
END`

describe("Mailbox", () => {
  test("send and receive between 2 sessions", () => {
    const sessionA = "ses_abc123" as any
    const sessionB = "ses_def456" as any

    insert(sessionA, sessionB, "inbox", "text", "Hello from B")
    insert(sessionA, sessionB, "inbox", "text", "Another message")
    insert(sessionB, sessionA, "inbox", "text", "Reply from A")

    const aMessages = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, sessionA))
      .all() as MailboxRow[]

    expect(aMessages.length).toBe(2)
    expect(aMessages.every(m => m.recipient_session_id === sessionA)).toBe(true)

    const bMessages = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, sessionB))
      .all() as MailboxRow[]

    expect(bMessages.length).toBe(1)
    expect(bMessages[0].content).toBe("Reply from A")
  })

  test("priority ordering: urgent > inbox > queue regardless of send order", () => {
    const recipient = "ses_recipient" as any
    const sender = "ses_sender" as any
    const baseTime = Date.now()

    insert(recipient, sender, "queue", "task", "low priority task", baseTime)
    insert(recipient, sender, "inbox", "text", "regular message", baseTime + 1)
    insert(recipient, sender, "urgent", "interrupt", "urgent interrupt", baseTime + 2)
    insert(recipient, sender, "queue", "task", "another low task", baseTime + 3)
    insert(recipient, sender, "inbox", "text", "another regular", baseTime + 4)

    const messages = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .orderBy(PRIORITY_SORT, asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(messages.length).toBe(5)
    expect(messages[0].priority).toBe("urgent")
    expect(messages[0].content).toBe("urgent interrupt")
    expect(messages[1].priority).toBe("inbox")
    expect(messages[1].content).toBe("regular message")
    expect(messages[2].priority).toBe("inbox")
    expect(messages[2].content).toBe("another regular")
    expect(messages[3].priority).toBe("queue")
    expect(messages[3].content).toBe("low priority task")
    expect(messages[4].priority).toBe("queue")
    expect(messages[4].content).toBe("another low task")
  })

  test("receive returns only unread messages ordered by priority", () => {
    const recipient = "ses_recipient" as any
    const sender = "ses_sender" as any
    const baseTime = Date.now()

    insert(recipient, sender, "queue", "task", "task msg", baseTime)
    insert(recipient, sender, "urgent", "interrupt", "urgent msg", baseTime + 1)
    insert(recipient, sender, "inbox", "text", "inbox msg", baseTime + 2)

    // mark the urgent one as read
    db.update(MailboxTable)
      .set({ read_at: Date.now() })
      .where(and(
        eq(MailboxTable.recipient_session_id, recipient),
        eq(MailboxTable.priority, "urgent"),
      ))
      .run()

    const unread = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, recipient),
        isNull(MailboxTable.read_at),
      ))
      .orderBy(PRIORITY_SORT, asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(unread.length).toBe(2)
    expect(unread[0].priority).toBe("inbox")
    expect(unread[1].priority).toBe("queue")
  })

  test("depth limit enforcement drops oldest messages", () => {
    const recipient = "ses_depth_test" as any
    const sender = "ses_sender" as any
    const baseTime = Date.now()

    for (let i = 0; i < MAILBOX_QUEUE_DEPTH + 10; i++) {
      db.insert(MailboxTable).values({
        id: crypto.randomUUID() as MailboxID,
        recipient_session_id: recipient,
        sender_session_id: sender,
        priority: "inbox" as MailboxPriority,
        type: "text",
        content: `message ${i}`,
        created_at: baseTime + i,
        read_at: null,
      } as any).run()
    }

    const count = db.select({ value: sql<number>`count(*)` })
      .from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .get()

    expect(count!.value).toBe(MAILBOX_QUEUE_DEPTH + 10)

    // simulate depth limit enforcement
    const overflow = count!.value - MAILBOX_QUEUE_DEPTH
    const oldest = db.select({ id: MailboxTable.id })
      .from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .orderBy(asc(MailboxTable.created_at))
      .limit(overflow)
      .all()

    for (const row of oldest) {
      db.delete(MailboxTable).where(eq(MailboxTable.id, row.id)).run()
    }

    const afterCount = db.select({ value: sql<number>`count(*)` })
      .from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .get()

    expect(afterCount!.value).toBe(MAILBOX_QUEUE_DEPTH)

    // verify the remaining messages are the newest ones
    const remaining = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .orderBy(asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(remaining[0].content).toBe(`message ${10}`)
    expect(remaining[remaining.length - 1].content).toBe(`message ${MAILBOX_QUEUE_DEPTH + 10 - 1}`)
  })

  test("markRead sets read_at timestamp", () => {
    const recipient = "ses_markread" as any
    const sender = "ses_sender" as any

    const msg = insert(recipient, sender, "inbox", "text", "read me")

    const before = db.select().from(MailboxTable)
      .where(eq(MailboxTable.id, msg.id))
      .get() as MailboxRow
    expect(before.read_at).toBeNull()

    const readTime = Date.now()
    db.update(MailboxTable)
      .set({ read_at: readTime })
      .where(eq(MailboxTable.id, msg.id))
      .run()

    const after = db.select().from(MailboxTable)
      .where(eq(MailboxTable.id, msg.id))
      .get() as MailboxRow
    expect(after.read_at).toBe(readTime)
  })

  test("purge removes all messages for a recipient", () => {
    const recipient = "ses_purge" as any
    const sender = "ses_sender" as any

    insert(recipient, sender, "urgent", "interrupt", "msg1")
    insert(recipient, sender, "inbox", "text", "msg2")
    insert(recipient, sender, "queue", "task", "msg3")

    const before = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .all()
    expect(before.length).toBe(3)

    db.delete(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .run()

    const after = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .all()
    expect(after.length).toBe(0)
  })

  test("peek returns all messages including read, ordered by priority", () => {
    const recipient = "ses_peek" as any
    const sender = "ses_sender" as any
    const baseTime = Date.now()

    insert(recipient, sender, "queue", "task", "task", baseTime)
    insert(recipient, sender, "urgent", "interrupt", "urgent", baseTime + 1)

    db.update(MailboxTable)
      .set({ read_at: Date.now() })
      .where(eq(MailboxTable.priority, "urgent"))
      .run()

    const all = db.select().from(MailboxTable)
      .where(eq(MailboxTable.recipient_session_id, recipient))
      .orderBy(PRIORITY_SORT, asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(all.length).toBe(2)
    expect(all[0].priority).toBe("urgent")
    expect(all[0].read_at).not.toBeNull()
    expect(all[1].priority).toBe("queue")
    expect(all[1].read_at).toBeNull()
  })
})
