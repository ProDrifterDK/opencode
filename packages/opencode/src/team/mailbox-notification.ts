import type { SessionID } from "@/session/schema"
import type { MailboxID, MailboxRow } from "./mailbox.sql"
import type { SenderIdentity } from "./message-routing"
import type { EngineerID } from "./types"

type EngineerSender = {
  engineerID: EngineerID
  name: string
}

export const selectUnreadMessageForEvent = (
  messages: readonly MailboxRow[],
  input: {
    messageID: MailboxID
    recipientSessionID: SessionID
  },
) =>
  messages.find(
    (message) =>
      message.id === input.messageID &&
      message.recipient_session_id === input.recipientSessionID &&
      message.read_at === null,
  ) ?? null

export const resolveLeadNotificationSender = (input: {
  senderSessionID: SessionID
  leadSessionID: SessionID
  senderEngineer: EngineerSender | null
}): SenderIdentity => {
  if (input.senderSessionID === input.leadSessionID) return { type: "lead" }
  if (input.senderEngineer) {
    return {
      type: "engineer",
      name: input.senderEngineer.name,
      engineerID: input.senderEngineer.engineerID,
    }
  }
  return { type: "unknown" }
}

export const teamCompleteSenderSessionID = (team: { leadSessionID: SessionID }) => team.leadSessionID

export const hasTeamReportNotification = (
  messages: readonly MailboxRow[],
  input: {
    recipientSessionID: SessionID
    senderSessionID: SessionID
    content: string
  },
) => findTeamReportNotification(messages, input) !== null

export const findTeamReportNotification = (
  messages: readonly MailboxRow[],
  input: {
    recipientSessionID: SessionID
    senderSessionID: SessionID
    content: string
  },
) => messages.find(
  (message) =>
    message.recipient_session_id === input.recipientSessionID &&
    message.sender_session_id === input.senderSessionID &&
    message.type === "team_report" &&
    message.content === input.content,
) ?? null

export const hasTeamCompleteNotification = (
  messages: readonly MailboxRow[],
  input: {
    recipientSessionID: SessionID
    teamID: string
  },
) => messages.some(
  (message) =>
    message.recipient_session_id === input.recipientSessionID &&
    message.type === "team_complete" &&
    message.content.startsWith(`✅ Team ${input.teamID} complete`),
)
