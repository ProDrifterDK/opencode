import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { eq, and, asc, isNull, sql } from "drizzle-orm"
import { MailboxTable, type MailboxID, type MailboxPriority, type MailboxRow } from "../../src/team/mailbox.sql"

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

function migrate(db: any, migrations: any[]) {
  for (const m of migrations) {
    db.run(m.sql)
  }
}

describe("Mailbox Integration - RunLoop Scenarios", () => {
  const engineer = "ses_engineer_001" as any
  const lead = "ses_lead_001" as any
  const other = "ses_other_001" as any

  test("receiveByPriority returns only unread messages of specified priority", () => {
    insert(engineer, lead, "urgent", "interrupt", "stop what you're doing")
    insert(engineer, lead, "inbox", "text", "check this")
    insert(engineer, lead, "queue", "task", "low priority task")
    insert(engineer, lead, "urgent", "interrupt", "another urgent")

    const urgentOnly = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        eq(MailboxTable.priority, "urgent"),
        isNull(MailboxTable.read_at),
      ))
      .orderBy(asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(urgentOnly.length).toBe(2)
    expect(urgentOnly.every(m => m.priority === "urgent")).toBe(true)
    expect(urgentOnly[0].content).toBe("stop what you're doing")
    expect(urgentOnly[1].content).toBe("another urgent")

    const inboxOnly = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        eq(MailboxTable.priority, "inbox"),
        isNull(MailboxTable.read_at),
      ))
      .orderBy(asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(inboxOnly.length).toBe(1)
    expect(inboxOnly[0].content).toBe("check this")
  })

  test("hasUnread checks for unread messages with optional priority filter", () => {
    expect(hasUnread(engineer)).toBe(false)

    insert(engineer, lead, "queue", "task", "background task")
    expect(hasUnread(engineer)).toBe(true)
    expect(hasUnread(engineer, "urgent")).toBe(false)
    expect(hasUnread(engineer, "queue")).toBe(true)

    insert(engineer, lead, "urgent", "interrupt", "urgent msg")
    expect(hasUnread(engineer, "urgent")).toBe(true)
  })

  test("mailbox check priority order: urgent > inbox > queue", () => {
    insert(engineer, lead, "queue", "task", "low task", 1000)
    insert(engineer, lead, "inbox", "text", "regular message", 1001)
    insert(engineer, lead, "urgent", "interrupt", "URGENT!", 1002)

    const priorities: MailboxPriority[] = ["urgent", "inbox", "queue"]
    let found: MailboxRow | null = null

    for (const p of priorities) {
      const msgs = db.select().from(MailboxTable)
        .where(and(
          eq(MailboxTable.recipient_session_id, engineer),
          eq(MailboxTable.priority, p),
          isNull(MailboxTable.read_at),
        ))
        .orderBy(asc(MailboxTable.created_at))
        .all() as MailboxRow[]

      if (msgs.length > 0 && !found) {
        found = msgs[0]
      }
    }

    expect(found).not.toBeNull()
    expect(found!.priority).toBe("urgent")
    expect(found!.content).toBe("URGENT!")
  })

  test("engineer processes inbox between turns: mark read after retrieval", () => {
    insert(engineer, lead, "inbox", "text", "turn message")

    const msgs = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        eq(MailboxTable.priority, "inbox"),
        isNull(MailboxTable.read_at),
      ))
      .all() as MailboxRow[]

    expect(msgs.length).toBe(1)
    const msg = msgs[0]

    db.update(MailboxTable)
      .set({ read_at: Date.now() })
      .where(eq(MailboxTable.id, msg.id))
      .run()

    const afterMark = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        eq(MailboxTable.priority, "inbox"),
        isNull(MailboxTable.read_at),
      ))
      .all() as MailboxRow[]

    expect(afterMark.length).toBe(0)
  })

  test("urgent message arrives mid-loop: engineer gets interrupt", () => {
    const baseTime = Date.now()
    insert(engineer, lead, "inbox", "text", "original task", baseTime)
    insert(engineer, lead, "urgent", "interrupt", "DROP EVERYTHING", baseTime + 1000)

    const priorities: MailboxPriority[] = ["urgent", "inbox", "queue"]
    let foundPriority: MailboxPriority | null = null
    let foundMsg: MailboxRow | null = null

    for (const p of priorities) {
      const msgs = db.select().from(MailboxTable)
        .where(and(
          eq(MailboxTable.recipient_session_id, engineer),
          eq(MailboxTable.priority, p),
          isNull(MailboxTable.read_at),
        ))
        .orderBy(asc(MailboxTable.created_at))
        .all() as MailboxRow[]

      if (msgs.length > 0 && !foundMsg) {
        foundMsg = msgs[0]
        foundPriority = p
        break
      }
    }

    expect(foundPriority).toBe("urgent")
    expect(foundMsg!.content).toBe("DROP EVERYTHING")
  })

  test("lead daemon polls and finds urgent message", () => {
    insert(lead, engineer, "urgent", "status", "CRITICAL FAILURE")

    expect(hasUnread(lead, "urgent")).toBe(true)

    const urgentMsgs = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, lead),
        eq(MailboxTable.priority, "urgent"),
        isNull(MailboxTable.read_at),
      ))
      .orderBy(asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(urgentMsgs.length).toBe(1)

    for (const msg of urgentMsgs) {
      db.update(MailboxTable)
        .set({ read_at: Date.now() })
        .where(eq(MailboxTable.id, msg.id))
        .run()
    }

    expect(hasUnread(lead, "urgent")).toBe(false)
  })

  test("queue messages only processed when idle", () => {
    insert(engineer, lead, "queue", "task", "background task 1")
    insert(engineer, lead, "queue", "task", "background task 2")

    expect(hasUnread(engineer, "urgent")).toBe(false)
    expect(hasUnread(engineer, "inbox")).toBe(false)
    expect(hasUnread(engineer, "queue")).toBe(true)

    const queueMsgs = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        eq(MailboxTable.priority, "queue"),
        isNull(MailboxTable.read_at),
      ))
      .orderBy(asc(MailboxTable.created_at))
      .all() as MailboxRow[]

    expect(queueMsgs.length).toBe(2)
    expect(queueMsgs[0].content).toBe("background task 1")
    expect(queueMsgs[1].content).toBe("background task 2")
  })

  test("non-team session mailbox is isolated", () => {
    insert(engineer, lead, "inbox", "text", "for engineer")
    insert(other, lead, "inbox", "text", "for other session")

    const engineerMsgs = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, engineer),
        isNull(MailboxTable.read_at),
      ))
      .all() as MailboxRow[]

    expect(engineerMsgs.length).toBe(1)
    expect(engineerMsgs[0].content).toBe("for engineer")

    const otherMsgs = db.select().from(MailboxTable)
      .where(and(
        eq(MailboxTable.recipient_session_id, other),
        isNull(MailboxTable.read_at),
      ))
      .all() as MailboxRow[]

    expect(otherMsgs.length).toBe(1)
    expect(otherMsgs[0].content).toBe("for other session")
  })
})

function hasUnread(recipient: string, priority?: MailboxPriority): boolean {
  const conditions = [
    eq(MailboxTable.recipient_session_id, recipient as any),
    isNull(MailboxTable.read_at),
  ]
  if (priority) conditions.push(eq(MailboxTable.priority, priority))

  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(MailboxTable)
    .where(and(...conditions))
    .get()

  return (row?.value ?? 0) > 0
}
