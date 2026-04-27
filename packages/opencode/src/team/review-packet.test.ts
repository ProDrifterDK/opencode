import { describe, expect, test } from "bun:test"
import { buildReviewPacket, decodeReviewPacket, encodeReviewPacket } from "./review-packet"

describe("team review packet", () => {
  test("records structured evidence without warnings when complete", () => {
    const packet = buildReviewPacket({
      status: "completed",
      summary: "Implemented behavior. Tests passed.",
      reportPath: ".tmp/report-engineer.md",
      changedFiles: ["src/foo.ts"],
      verificationCommands: ["bun test src/foo.test.ts"],
      knownGaps: [],
      confidence: "high",
    })

    expect(packet.reportPath).toBe(".tmp/report-engineer.md")
    expect(packet.changedFiles).toEqual(["src/foo.ts"])
    expect(packet.verificationCommands).toEqual(["bun test src/foo.test.ts"])
    expect(packet.confidence).toBe("high")
    expect(packet.warnings).toEqual([])
  })

  test("warns on missing evidence and weak verification claims", () => {
    const packet = buildReviewPacket({
      status: "completed",
      summary: "Tests passed with expect(true).toBe(true)",
      knownGaps: ["No real browser smoke run"],
      confidence: "low",
    })

    expect(packet.warnings).toContain("No reportPath supplied; Lead must find the detailed report manually.")
    expect(packet.warnings).toContain("No changedFiles supplied; Lead must inspect the branch diff manually.")
    expect(packet.warnings).toContain("No verificationCommands supplied; test claims are unaudited.")
    expect(packet.warnings).toContain("Summary claims tests passed but no verificationCommands were supplied.")
    expect(packet.warnings).toContain("Summary mentions a weak assertion pattern; inspect tests for tautologies.")
    expect(packet.warnings).toContain("Engineer reported low confidence; require Lead review before merge.")
  })

  test("round-trips through task board JSON storage", () => {
    const packet = buildReviewPacket({
      status: "completed",
      summary: "Done",
      reportPath: ".tmp/report.md",
      changedFiles: ["src/a.ts"],
      verificationCommands: ["bun typecheck"],
      confidence: "medium",
    })

    expect(decodeReviewPacket(encodeReviewPacket(packet))).toEqual(packet)
    expect(decodeReviewPacket("not-json")).toBeNull()
  })
})
