import { describe, expect, test } from "bun:test"
import type { SessionID } from "@/session/schema"
import type { EngineerID } from "./types"
import { buildReplyInstruction, formatTeamMessageLabel, resolveEngineerRecipient } from "./message-routing"

const engineers = [
  { engineerID: "eng_frontend" as EngineerID, sessionID: "sess_frontend" as SessionID, name: "engineer-frontend" },
  { engineerID: "eng_docs" as EngineerID, sessionID: "sess_docs" as SessionID, name: "engineer-docs-reviewer" },
  { engineerID: "eng_backend" as EngineerID, sessionID: "sess_backend" as SessionID, name: "engineer-backend" },
]

describe("team message routing", () => {
  test("resolves exact engineer IDs before names", () => {
    const result = resolveEngineerRecipient("eng_docs", engineers)

    expect(result.type).toBe("engineer")
    if (result.type !== "engineer") return
    expect(result.recipientSessionID).toBe("sess_docs" as SessionID)
    expect(result.resolvedRecipientID).toBe("eng_docs" as EngineerID)
    expect(result.inputWasAlias).toBe(false)
  })

  test("resolves unique engineer names as aliases", () => {
    const result = resolveEngineerRecipient("engineer-frontend", engineers)

    expect(result.type).toBe("engineer")
    if (result.type !== "engineer") return
    expect(result.recipientSessionID).toBe("sess_frontend" as SessionID)
    expect(result.resolvedRecipientID).toBe("eng_frontend" as EngineerID)
    expect(result.inputWasAlias).toBe(true)
  })

  test("rejects ambiguous engineer name aliases", () => {
    const result = resolveEngineerRecipient("engineer-frontend", [
      ...engineers,
      { engineerID: "eng_frontend_2" as EngineerID, sessionID: "sess_frontend_2" as SessionID, name: "engineer-frontend" },
    ])

    expect(result.type).toBe("error")
    if (result.type !== "error") return
    expect(result.message).toContain("Ambiguous recipient")
    expect(result.message).toContain("exact engineer ID")
  })

  test("formats lead sender labels and reply instructions explicitly", () => {
    expect(formatTeamMessageLabel({ sender: { type: "lead" }, priority: "inbox" })).toBe("[MESSAGE FROM LEAD]")
    expect(buildReplyInstruction({ type: "lead" })).toBe('Reply using team_message with recipientID "lead".')
  })

  test("formats engineer sender labels and reply instructions with stable IDs", () => {
    const sender = { type: "engineer" as const, name: "engineer-docs-reviewer", engineerID: "eng_docs" as EngineerID }

    expect(formatTeamMessageLabel({ sender, priority: "urgent" })).toBe("[URGENT MESSAGE FROM ENGINEER-DOCS-REVIEWER]")
    expect(buildReplyInstruction(sender)).toBe('Reply using team_message with recipientID "eng_docs".')
  })
})
