/**
 * formatPartProgress — pure function that translates a MessageV2.Part into a
 * short sidebar label for the engineer's live progress row.
 *
 * Extracted into its own module so it can be unit-tested without pulling in
 * the heavy `@/bus` / `AppRuntime` transitive dependency chain that makes
 * direct imports of `engineer-loop.ts` fail in test environments.
 */
import type { MessageV2 } from "@/session/message-v2"

/**
 * Translate a `MessageV2.Part` into a short progress label suitable for the
 * sidebar, or `null` when the part should not produce an update.
 *
 * Rules:
 *   - text / reasoning  → "💭 Thinking..."  (caller handles once-per-turn guard)
 *   - tool with state.status "running"       → "🔧 <toolName> <short args>"
 *   - team_message tool (running)            → "📤 team_message → <recipient>"
 *   - tool with state.status "completed"     → null  (no spam)
 *   - everything else                        → null
 */
export function formatPartProgress(part: MessageV2.Part): string | null {
  if (part.type === "text" || part.type === "reasoning") {
    return "💭 Thinking..."
  }

  if (part.type === "tool") {
    const status = (part.state as { status?: string } | undefined)?.status
    if (status !== "running") return null

    const toolName = part.tool ?? ""

    // team_message: surface recipient if available
    if (toolName === "team_message") {
      const recipientID =
        (part.state as { input?: Record<string, unknown> } | undefined)?.input?.["recipientID"]
      const suffix = typeof recipientID === "string" ? ` → ${recipientID.slice(0, 20)}` : ""
      return `📤 team_message${suffix}`
    }

    // Generic tool: format name + first string argument value (truncated)
    const input = (part.state as { input?: Record<string, unknown> } | undefined)?.input ?? {}
    const firstVal = Object.values(input).find((v) => typeof v === "string") as string | undefined
    const argSnippet = firstVal
      ? " " + (firstVal.length > 25 ? firstVal.slice(0, 25) + "…" : firstVal)
      : ""
    const label = `🔧 ${toolName}${argSnippet}`
    return label.length > 50 ? label.slice(0, 49) + "…" : label
  }

  return null
}
