import type { HumanGate, MissionContract } from "../team/mission-contract"

export const missingMissionContractWarning = "Mission Contract: missing — call team_contract_create before spawning engineers."

export const teamContractToolNames = [
  "TeamContractCreateTool",
  "TeamContractUpdateTool",
  "TeamContractApproveTool",
  "TeamContractExportTool",
] as const

export const humanGateCounts = (humanGates: readonly HumanGate[]) =>
  humanGates.reduce(
    (acc, gate) => {
      acc[gate.status] += 1
      return acc
    },
    { pending: 0, satisfied: 0, waived: 0 },
  )

export const formatMissionContractSpawnWarning = (contract: MissionContract) =>
  `Mission Contract: not approved — status=${contract.status}, currentPhase=${contract.currentPhase}. Call team_contract_approve before spawning engineers.`

export const resolveMissionContractSpawnState = (contract: MissionContract | null) => ({
  warnings: contract
    ? contract.status === "approved"
      ? []
      : [formatMissionContractSpawnWarning(contract)]
    : [missingMissionContractWarning],
  shouldAdvanceToExecuting: contract?.status === "approved",
})

export const formatMissionContractMonitorBlock = (contract: MissionContract | null) => {
  if (!contract) {
    return {
      lines: [
        "Mission Contract: missing",
        "  Recommendation: call team_contract_create before spawning engineers.",
      ],
      metadata: { present: false as const },
    }
  }

  const gateCounts = humanGateCounts(contract.humanGates)
  return {
    lines: [
      "Mission Contract:",
      `  Status: ${contract.status}`,
      `  Phase: ${contract.currentPhase}`,
      `  Objective: ${contract.objective}`,
      `  Success criteria: ${contract.successCriteria.length}`,
      `  Human gates: ${gateCounts.pending} pending, ${gateCounts.satisfied} satisfied, ${gateCounts.waived} waived`,
      `  Export: ${contract.exportPath ?? "not exported"}`,
    ],
    metadata: {
      present: true as const,
      contractID: contract.id,
      status: contract.status,
      phase: contract.currentPhase,
      objective: contract.objective,
      successCriteria: contract.successCriteria.length,
      humanGates: {
        total: contract.humanGates.length,
        pending: gateCounts.pending,
        satisfied: gateCounts.satisfied,
        waived: gateCounts.waived,
      },
      exportPath: contract.exportPath ?? null,
    },
  }
}
