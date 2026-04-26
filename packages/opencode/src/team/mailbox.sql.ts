import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import type { SessionID } from "../session/schema"

// =============================================================================
// Types
// =============================================================================

export type MailboxPriority = "urgent" | "inbox" | "queue"

export type MailboxID = string & { readonly __brand: "MailboxID" }

export interface MailboxRow {
  id: MailboxID
  recipient_session_id: SessionID
  sender_session_id: SessionID
  priority: MailboxPriority
  type: string
  content: string
  created_at: number
  read_at: number | null
}

export type MessageBatch = {
  readonly type: string
  readonly messages: MailboxRow[]
}

// =============================================================================
// Table
// =============================================================================

export const MailboxTable = sqliteTable(
  "mailbox",
  {
    id: text().$type<MailboxID>().primaryKey(),
    recipient_session_id: text().$type<SessionID>().notNull(),
    sender_session_id: text().$type<SessionID>().notNull(),
    priority: text().$type<MailboxPriority>().notNull(),
    type: text().notNull(),
    content: text().notNull(),
    created_at: integer().notNull(),
    read_at: integer(),
  },
  (table) => [
    index("mailbox_recipient_priority_created_idx").on(table.recipient_session_id, table.priority, table.created_at),
    index("mailbox_recipient_read_idx").on(table.recipient_session_id, table.read_at),
  ],
)
