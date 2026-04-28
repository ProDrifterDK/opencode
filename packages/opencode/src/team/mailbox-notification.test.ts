import { describe, expect, test } from "bun:test"
import type { SessionID } from "@/session/schema"
import type { MailboxID, MailboxRow } from "./mailbox.sql"
import { findTeamReportNotification, hasTeamCompleteNotification, hasTeamReportNotification, resolveLeadNotificationSender, selectUnreadMessageForEvent, teamCompleteSenderSessionID } from "./mailbox-notification"
import type { EngineerID } from "./types"

const leadSessionID = "ses_lead" as SessionID
const frontendSessionID = "ses_frontend" as SessionID
const backendSessionID = "ses_backend" as SessionID

const makeMessage = (input: Omit<Partial<MailboxRow>, "id"> & { id: string; sender_session_id: SessionID }): MailboxRow => ({
  id: input.id as MailboxID,
  recipient_session_id: input.recipient_session_id ?? leadSessionID,
  sender_session_id: input.sender_session_id,
  priority: input.priority ?? "inbox",
  type: input.type ?? "team_message",
  content: input.content ?? input.id,
  created_at: input.created_at ?? Date.now(),
  read_at: input.read_at ?? null,
})

describe("mailbox notification helpers", () => {
  test("selects the exact unread row for the mailbox event", () => {
    const frontendMessage = makeMessage({
      id: "msg_frontend",
      sender_session_id: frontendSessionID,
      created_at: 1,
      content: "Frontend review complete",
    })
    const backendMessage = makeMessage({
      id: "msg_backend",
      sender_session_id: backendSessionID,
      created_at: 2,
      content: "Backend review complete",
    })

    expect(selectUnreadMessageForEvent([frontendMessage, backendMessage], {
      messageID: backendMessage.id,
      recipientSessionID: leadSessionID,
    })?.content).toBe("Backend review complete")
  })

  test("does not select already-read rows even when the event id matches", () => {
    const readMessage = makeMessage({
      id: "msg_read",
      sender_session_id: frontendSessionID,
      read_at: Date.now(),
    })

    expect(selectUnreadMessageForEvent([readMessage], {
      messageID: readMessage.id,
      recipientSessionID: leadSessionID,
    })).toBeNull()
  })

  test("resolves lead-originated lead notifications as lead", () => {
    expect(resolveLeadNotificationSender({
      senderSessionID: leadSessionID,
      leadSessionID,
      senderEngineer: null,
    })).toEqual({ type: "lead" })
  })

  test("resolves engineer-originated lead notifications as engineer", () => {
    expect(resolveLeadNotificationSender({
      senderSessionID: frontendSessionID,
      leadSessionID,
      senderEngineer: {
        engineerID: "eng_frontend" as EngineerID,
        name: "engineer-frontend-review",
      },
    })).toEqual({
      type: "engineer",
      engineerID: "eng_frontend" as EngineerID,
      name: "engineer-frontend-review",
    })
  })

  test("uses the lead session for daemon-generated team completion messages", () => {
    expect(teamCompleteSenderSessionID({ leadSessionID })).toBe(leadSessionID)
  })

  test("finds existing team report notifications by recipient sender and content", () => {
    const report = makeMessage({
      id: "msg_report",
      sender_session_id: frontendSessionID,
      type: "team_report",
      content: "✅ Engineer engineer-frontend-review reports: COMPLETED",
    })

    expect(hasTeamReportNotification([report], {
      recipientSessionID: leadSessionID,
      senderSessionID: frontendSessionID,
      content: report.content,
    })).toBe(true)
    expect(findTeamReportNotification([report], {
      recipientSessionID: leadSessionID,
      senderSessionID: frontendSessionID,
      content: report.content,
    })?.id).toBe(report.id)
    expect(hasTeamReportNotification([report], {
      recipientSessionID: leadSessionID,
      senderSessionID: backendSessionID,
      content: report.content,
    })).toBe(false)
  })

  test("finds existing team completion notifications by team ID", () => {
    const complete = makeMessage({
      id: "msg_complete",
      sender_session_id: leadSessionID,
      type: "team_complete",
      priority: "urgent",
      content: "✅ Team team_1 complete\nAll 3 tasks completed.",
    })

    expect(hasTeamCompleteNotification([complete], {
      recipientSessionID: leadSessionID,
      teamID: "team_1",
    })).toBe(true)
    expect(hasTeamCompleteNotification([complete], {
      recipientSessionID: leadSessionID,
      teamID: "team_2",
    })).toBe(false)
  })
})
