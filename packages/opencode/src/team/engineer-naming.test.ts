import { describe, expect, it } from "bun:test"
import { deriveEngineerName } from "./engineer-naming"

describe("deriveEngineerName", () => {
  it("derives verb-noun from a typical task title", () => {
    expect(deriveEngineerName("Refactor auth middleware", 1)).toBe("engineer-refactor-auth")
  })

  it("keeps verbs like 'add' (not a stopword)", () => {
    expect(deriveEngineerName("Add billing endpoint", 2)).toBe("engineer-add-billing")
  })

  it("keeps verbs like 'fix'", () => {
    expect(deriveEngineerName("Fix login bug", 3)).toBe("engineer-fix-login")
  })

  it("keeps verbs like 'build'", () => {
    expect(deriveEngineerName("Build payment gateway", 4)).toBe("engineer-build-payment")
  })

  it("skips leading articles", () => {
    expect(deriveEngineerName("The refactor of auth", 1)).toBe("engineer-refactor-auth")
  })

  it("skips prepositions between tokens", () => {
    expect(deriveEngineerName("migration for database", 1)).toBe("engineer-migration-database")
  })

  it("returns fallback for empty title", () => {
    expect(deriveEngineerName("", 5)).toBe("engineer-5")
  })

  it("returns fallback for null title", () => {
    expect(deriveEngineerName(null, 7)).toBe("engineer-7")
  })

  it("returns fallback for undefined title", () => {
    expect(deriveEngineerName(undefined, 3)).toBe("engineer-3")
  })

  it("returns fallback for whitespace-only title", () => {
    expect(deriveEngineerName("   ", 2)).toBe("engineer-2")
  })

  it("returns fallback when only stopwords present", () => {
    expect(deriveEngineerName("the the the", 1)).toBe("engineer-1")
  })

  it("returns fallback when only one useful token", () => {
    expect(deriveEngineerName("the refactor", 2)).toBe("engineer-2")
  })

  it("truncates at hyphen boundary when result exceeds 40 chars", () => {
    const result = deriveEngineerName("Superlongverbwordthatexceedsfortychars superlongnounword", 1)
    expect(result.length).toBeLessThanOrEqual(40)
    // Should not end mid-token (last char should not be in the middle of a word run)
    expect(result).toMatch(/^engineer-[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("strips unicode and special chars from tokens", () => {
    expect(deriveEngineerName("Réfactor authentication", 1)).toBe("engineer-rfactor-authentication")
  })

  it("handles hyphenated task titles", () => {
    expect(deriveEngineerName("refactor-auth-service", 1)).toBe("engineer-refactor-auth")
  })

  it("lowercases all output", () => {
    expect(deriveEngineerName("REFACTOR AUTH", 1)).toBe("engineer-refactor-auth")
  })
})
