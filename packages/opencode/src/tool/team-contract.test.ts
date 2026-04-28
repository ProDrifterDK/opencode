import { describe, expect, test } from "bun:test"
import { teamContractToolNames } from "./team-contract-helpers"

const teamToolSource = await Bun.file(new URL("./team.ts", import.meta.url)).text()

describe("team contract tool source wiring", () => {
  test("defines all four mission contract tools", () => {
    expect(teamToolSource).toContain('"team_contract_create"')
    expect(teamToolSource).toContain('"team_contract_update"')
    expect(teamToolSource).toContain('"team_contract_approve"')
    expect(teamToolSource).toContain('"team_contract_export"')
  })

  test("uses requireLead guard for each contract tool", () => {
    expect(teamToolSource).toContain('requireLead(ctx, coordinator, "create a mission contract")')
    expect(teamToolSource).toContain('requireLead(ctx, coordinator, "update a mission contract")')
    expect(teamToolSource).toContain('requireLead(ctx, coordinator, "approve a mission contract")')
    expect(teamToolSource).toContain('requireLead(ctx, coordinator, "export a mission contract")')
  })

  test("TeamTools includes all contract tool definitions", () => {
    const start = teamToolSource.indexOf("export const TeamTools")
    const section = start >= 0 ? teamToolSource.slice(start) : ""

    for (const toolName of teamContractToolNames) {
      expect(section).toContain(toolName)
    }
  })

  test("team spawn and monitor use shared mission contract helpers", () => {
    expect(teamToolSource).toContain("resolveMissionContractSpawnState(contract)")
    expect(teamToolSource).toContain("formatMissionContractMonitorBlock(contract)")
  })

  test("team_spawn compensates side effects after engineer creation failures", () => {
    expect(teamToolSource).toContain("const cleanupTaskAndEngineer")
    expect(teamToolSource).toContain("taskBoard.update(task.id, { status: \"pending\", assigned_engineer_id: null })")
    expect(teamToolSource).toContain("taskBoard.delete(task.id)")
    expect(teamToolSource).toContain("coordinator.killEngineer({ teamID, engineerID: engineerSlot.engineerID })")
  })
})
