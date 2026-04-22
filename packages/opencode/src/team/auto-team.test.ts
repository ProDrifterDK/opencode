import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AutoTeam } from "./auto-team"
import { TeamID } from "./types"

const testLayer = AutoTeam.defaultLayer

describe("AutoTeam", () => {
  test("shouldUseTeam returns true for complex request with multiple files and keywords", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam(
          "implement auth with login.ts, signup.ts, jwt.ts, and tests",
        )
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(true)
  })

  test("shouldUseTeam returns false for simple request", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam("fix typo")
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(false)
  })

  test("shouldUseTeam true: refactor with multiple files and keywords", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam(
          "refactor the user service and add tests for auth.ts, api.ts, db.ts",
        )
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(true)
  })

  test("shouldUseTeam true: create module with files and keywords", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam(
          "create a new module with login.ts, signup.ts, profile.ts implementing the auth service",
        )
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(true)
  })

  test("shouldUseTeam false: only 2 files, no complexity keywords", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam("update README.md and package.json")
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(false)
  })

  test("shouldUseTeam false: vague short request", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam("fix everything")
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(false)
  })

  test("shouldUseTeam boundary: 3 files + 1 keyword = score 1, below threshold", () => {
    const msg = "implement fix for a.ts b.ts c.ts"
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam(msg)
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(false)
  })

  test("shouldUseTeam boundary: 3 files + 2 keywords = score 2, meets threshold", () => {
    const msg = "implement a new service handler for a.ts b.ts c.ts"
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.shouldUseTeam(msg)
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toBe(true)
  })

  test("getConfig returns enabled state from env", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.getConfig()
      }).pipe(Effect.provide(testLayer)),
    )
    // env default: OPENCODE_AUTO_TEAM not set → enabled=true
    expect(result.enabled).toBe(true)
    expect(result.threshold).toBe(2)
  })

  test("buildPrompt includes AUTO-TEAM marker and teamID", () => {
    const teamID = TeamID.ascending("team_test_123")
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        return autoTeam.buildPrompt(teamID)
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toContain("[AUTO-TEAM]")
    expect(result).toContain("team_test_123")
    expect(result).toContain("spawnEngineer")
    expect(result).toContain("LeadCoordinator.assign")
    expect(result.length).toBeGreaterThan(50)
  })

  test("buildPrompt with generated TeamID", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const autoTeam = yield* AutoTeam.Service
        const teamID = TeamID.ascending()
        return autoTeam.buildPrompt(teamID)
      }).pipe(Effect.provide(testLayer)),
    )
    expect(result).toContain("[AUTO-TEAM]")
    expect(result).toContain("team_")
  })
})
