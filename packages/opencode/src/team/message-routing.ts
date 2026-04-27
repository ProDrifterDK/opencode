import type { SessionID } from "@/session/schema"
import type { EngineerID } from "./types"

type EngineerRecipient = {
  engineerID: EngineerID
  sessionID: SessionID
  name: string
}

export type SenderIdentity =
  | { type: "lead" }
  | { type: "engineer"; name: string; engineerID: EngineerID }
  | { type: "unknown" }

export type RecipientResolution =
  | { type: "lead"; recipientSessionID: SessionID; resolvedRecipientID: "lead"; recipientName: "Lead"; inputWasAlias: false }
  | { type: "engineer"; recipientSessionID: SessionID; resolvedRecipientID: EngineerID; recipientName: string; inputWasAlias: boolean }
  | { type: "error"; message: string }

const normalizeRecipient = (value: string) => value.trim().toLowerCase()

export const resolveEngineerRecipient = (
  recipientID: string,
  engineers: readonly EngineerRecipient[],
): RecipientResolution => {
  const byID = engineers.find((engineer) => engineer.engineerID === recipientID)
  if (byID) {
    return {
      type: "engineer",
      recipientSessionID: byID.sessionID,
      resolvedRecipientID: byID.engineerID,
      recipientName: byID.name,
      inputWasAlias: false,
    }
  }

  const matches = engineers.filter((engineer) => normalizeRecipient(engineer.name) === normalizeRecipient(recipientID))
  if (matches.length === 1) {
    return {
      type: "engineer",
      recipientSessionID: matches[0].sessionID,
      resolvedRecipientID: matches[0].engineerID,
      recipientName: matches[0].name,
      inputWasAlias: true,
    }
  }

  if (matches.length > 1) {
    return {
      type: "error",
      message: `Ambiguous recipient "${recipientID}" matched ${matches.length} engineers. Use team_roster and send the exact engineer ID.`,
    }
  }

  return {
    type: "error",
    message: `Engineer "${recipientID}" not found. Use team_roster to get the exact engineer ID, or use the engineer's unique name.`,
  }
}

export const formatTeamMessageLabel = (input: {
  sender: SenderIdentity
  priority: "urgent" | "inbox" | "queue"
}) => {
  const senderName = input.sender.type === "lead"
    ? "LEAD"
    : input.sender.type === "engineer"
      ? input.sender.name
      : "teammate"
  const prefix = input.priority === "urgent" ? "URGENT MESSAGE" : input.priority === "queue" ? "LOW PRIORITY MESSAGE" : "MESSAGE"
  return `[${prefix} FROM ${input.priority === "urgent" ? senderName.toUpperCase() : senderName}]`
}

export const buildReplyInstruction = (sender: SenderIdentity) => {
  if (sender.type === "lead") return `Reply using team_message with recipientID "lead".`
  if (sender.type === "engineer") return `Reply using team_message with recipientID "${sender.engineerID}".`
  return "Reply using team_message after checking team_roster for the exact recipientID."
}
