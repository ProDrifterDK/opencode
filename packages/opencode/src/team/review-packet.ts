import { Schema } from "effect"

export const ReviewPacketSchema = Schema.Struct({
  reportPath: Schema.optional(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  verificationCommands: Schema.Array(Schema.String),
  knownGaps: Schema.Array(Schema.String),
  confidence: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  warnings: Schema.Array(Schema.String),
})

export type ReviewPacket = Schema.Schema.Type<typeof ReviewPacketSchema>

export const weakVerificationPattern = /(expect\(true\)\.toBe\(true\)|\.toBeTruthy\(\)|[<>]=?\s*0\b)/

export function buildReviewWarnings(input: {
  status: "completed" | "blocked" | "failed"
  summary: string
  reportPath?: string
  changedFiles: readonly string[]
  verificationCommands: readonly string[]
  knownGaps: readonly string[]
  confidence?: "low" | "medium" | "high"
}) {
  const warnings: string[] = []
  if (input.status === "completed" && !input.reportPath) warnings.push("No reportPath supplied; Lead must find the detailed report manually.")
  if (input.status === "completed" && input.changedFiles.length === 0) warnings.push("No changedFiles supplied; Lead must inspect the branch diff manually.")
  if (input.status === "completed" && input.verificationCommands.length === 0) warnings.push("No verificationCommands supplied; test claims are unaudited.")
  if (input.knownGaps.length > 0) warnings.push(`Known gaps reported: ${input.knownGaps.join("; ")}`)
  if (input.confidence === "low") warnings.push("Engineer reported low confidence; require Lead review before merge.")
  if (/tests?\s+(pass|passed|good|green)/i.test(input.summary) && input.verificationCommands.length === 0) warnings.push("Summary claims tests passed but no verificationCommands were supplied.")
  if (weakVerificationPattern.test(input.summary)) warnings.push("Summary mentions a weak assertion pattern; inspect tests for tautologies.")
  return warnings
}

export function buildReviewPacket(input: {
  status: "completed" | "blocked" | "failed"
  summary: string
  reportPath?: string
  changedFiles?: readonly string[]
  verificationCommands?: readonly string[]
  knownGaps?: readonly string[]
  confidence?: "low" | "medium" | "high"
}): ReviewPacket {
  const packet = {
    reportPath: input.reportPath,
    changedFiles: [...(input.changedFiles ?? [])],
    verificationCommands: [...(input.verificationCommands ?? [])],
    knownGaps: [...(input.knownGaps ?? [])],
    confidence: input.confidence,
  }
  return {
    ...packet,
    warnings: buildReviewWarnings({
      status: input.status,
      summary: input.summary,
      reportPath: packet.reportPath,
      changedFiles: packet.changedFiles,
      verificationCommands: packet.verificationCommands,
      knownGaps: packet.knownGaps,
      confidence: packet.confidence,
    }),
  }
}

export function encodeReviewPacket(packet: ReviewPacket) {
  return JSON.stringify(packet)
}

export function decodeReviewPacket(raw: string | null | undefined): ReviewPacket | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as Record<string, unknown>
    return {
      reportPath: typeof record.reportPath === "string" ? record.reportPath : undefined,
      changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles.filter((item): item is string => typeof item === "string") : [],
      verificationCommands: Array.isArray(record.verificationCommands) ? record.verificationCommands.filter((item): item is string => typeof item === "string") : [],
      knownGaps: Array.isArray(record.knownGaps) ? record.knownGaps.filter((item): item is string => typeof item === "string") : [],
      confidence: record.confidence === "low" || record.confidence === "medium" || record.confidence === "high" ? record.confidence : undefined,
      warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [],
    }
  } catch {
    return null
  }
}

export function formatReviewPacket(packet: ReviewPacket) {
  return [
    packet.reportPath ? `Report: ${packet.reportPath}` : null,
    packet.changedFiles.length > 0 ? `Changed files: ${packet.changedFiles.join(", ")}` : null,
    packet.verificationCommands.length > 0 ? `Verification: ${packet.verificationCommands.join(" && ")}` : null,
    packet.knownGaps.length > 0 ? `Known gaps: ${packet.knownGaps.join("; ")}` : null,
    packet.confidence ? `Confidence: ${packet.confidence}` : null,
    packet.warnings.length > 0 ? `Review warnings: ${packet.warnings.join("; ")}` : null,
  ].filter((line): line is string => line !== null)
}

export * as TeamReviewPacket from "./review-packet"
