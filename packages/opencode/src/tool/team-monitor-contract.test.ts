import { describe, expect, test } from "bun:test"
import { formatMissionContractMonitorBlock } from "./team-contract-helpers"
import type { MissionContract } from "../team/mission-contract"
import type { MissionContractID } from "../team/mission-contract.sql"
import type { TeamID } from "../team/types"

const TEAM_ID = "team_monitor" as TeamID
const CONTRACT_ID = "contract_monitor" as MissionContractID

const makeContract = (overrides?: Partial<MissionContract>): MissionContract => ({
  id: CONTRACT_ID,
  teamID: TEAM_ID,
  status: "approved",
  objective: "Ship mission contract monitor",
  successCriteria: ["text summary", "metadata summary", "focused tests"],
  constraints: ["no any"],
  nonGoals: ["no e2e"],
  humanGates: [
    {
      id: "gate_visual",
      kind: "visual",
      description: "Manual UX sweep",
      requiredBeforePhase: "delivery",
      status: "pending",
    },
    {
      id: "gate_product",
      kind: "product-approval",
      description: "Product signoff",
      requiredBeforePhase: "delivery",
      status: "satisfied",
    },
  ],
  currentPhase: "implementation",
  exportPath: ".tmp/team/team_monitor/mission.md",
  timeCreated: 1,
  timeUpdated: 2,
  ...overrides,
})

describe("team monitor mission contract helpers", () => {
  test("missing contract renders recommendation and metadata.present=false", () => {
    const result = formatMissionContractMonitorBlock(null)

    expect(result.lines).toEqual([
      "Mission Contract: missing",
      "  Recommendation: call team_contract_create before spawning engineers.",
    ])
    expect(result.metadata).toEqual({ present: false })
  })

  test("present contract renders text summary and machine-readable metadata", () => {
    const contract = makeContract()
    const result = formatMissionContractMonitorBlock(contract)

    expect(result.lines).toEqual([
      "Mission Contract:",
      "  Status: approved",
      "  Phase: implementation",
      "  Objective: Ship mission contract monitor",
      "  Success criteria: 3",
      "  Human gates: 1 pending, 1 satisfied, 0 waived",
      "  Export: .tmp/team/team_monitor/mission.md",
    ])
    expect(result.metadata).toEqual({
      present: true,
      contractID: CONTRACT_ID,
      status: "approved",
      phase: "implementation",
      objective: "Ship mission contract monitor",
      successCriteria: 3,
      humanGates: {
        total: 2,
        pending: 1,
        satisfied: 1,
        waived: 0,
      },
      exportPath: ".tmp/team/team_monitor/mission.md",
    })
  })
})
