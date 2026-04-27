import path from "node:path"
import { Global } from "@opencode-ai/core/global"

export function isOpenCodeAgentSource(source: string, globalConfig = Global.Path.config) {
  if (!source) return false
  if (source === "OPENCODE_CONFIG_CONTENT") return true
  if (source.startsWith("mobileconfig:")) return true
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const url = new URL(source)
    return url.pathname === "/.well-known/opencode" || url.pathname === "/api/config"
  }

  const normalized = source.split(path.sep).join("/")
  const normalizedGlobal = globalConfig.split(path.sep).join("/")
  if (normalized === normalizedGlobal || normalized.startsWith(`${normalizedGlobal}/`)) return true
  if (normalized.endsWith("/.opencode") || normalized.includes("/.opencode/")) return true
  return /\/opencode\.jsonc?$/.test(normalized)
}

export function isTeamVisibleAgent(
  agent: { name: string; native?: boolean; hidden?: boolean },
  origins: Record<string, { source: string }> | undefined,
  options: { includeNative?: boolean; globalConfig?: string } = {},
) {
  if (agent.hidden) return false
  if (!options.includeNative && agent.native) return false
  if (agent.native) return true
  const origin = origins?.[agent.name]
  if (!origin) return false
  return isOpenCodeAgentSource(origin.source, options.globalConfig)
}

export * as TeamAgentSource from "./agent-source"
