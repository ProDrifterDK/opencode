import { Effect, Layer, Context } from "effect"

import { AUTO_TEAM_ENABLED, AUTO_TEAM_THRESHOLD, AUTO_TEAM_MIN_FILES } from "./constants"
import type { TeamID } from "./types"

const FILE_PATTERN = /\b\w+\.\w{2,4}\b/g

const COMPLEXITY_KEYWORDS = [
  "implement",
  "refactor",
  "module",
  "system",
  "service",
  "feature",
  "endpoint",
  "api",
  "architecture",
  "redesign",
  "migration",
] as const

const ACTION_VERBS = [
  "create",
  "build",
  "add",
  "implement",
  "write",
  "design",
  "test",
  "deploy",
  "refactor",
  "migrate",
  "rewrite",
] as const

function countFiles(request: string): number {
  const matches = request.match(FILE_PATTERN)
  return matches ? matches.length : 0
}

function countComplexityKeywords(request: string): number {
  const lower = request.toLowerCase()
  return COMPLEXITY_KEYWORDS.filter((kw) => lower.includes(kw)).length
}

function countActionVerbs(request: string): number {
  const lower = request.toLowerCase()
  const seen = new Set<string>()
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) seen.add(verb)
  }
  return seen.size
}

export interface Interface {
  readonly shouldUseTeam: (request: string) => boolean
  readonly getConfig: () => { enabled: boolean; threshold: number }
  readonly buildPrompt: (teamID: TeamID) => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AutoTeam") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = {
      enabled: AUTO_TEAM_ENABLED,
      threshold: AUTO_TEAM_THRESHOLD,
    }

    const shouldUseTeam = (request: string): boolean => {
      if (!config.enabled) return false
      const score =
        (countFiles(request) >= AUTO_TEAM_MIN_FILES ? 1 : 0) +
        (countComplexityKeywords(request) >= 2 ? 1 : 0) +
        (request.length > 150 ? 1 : 0) +
        (countActionVerbs(request) >= 2 ? 1 : 0)
      return score >= config.threshold
    }

    const getConfig = () => config

    const buildPrompt = (teamID: TeamID): string =>
      `[AUTO-TEAM] This request has been flagged as complex. Team ${teamID} has been initialized. Please decompose this request into subtasks with non-overlapping file scopes, spawn engineers using SessionCoordinator.spawnEngineer, and assign tasks using LeadCoordinator.assign. Monitor progress and report to the user.`

    return Service.of({ shouldUseTeam, getConfig, buildPrompt })
  }),
)

export const defaultLayer = layer

export * as AutoTeam from "./auto-team"
