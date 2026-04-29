import { describe, expect, test } from "bun:test"
import { EngineerMemoryWatchdog, type SnapshotView } from "../team/engineer-memory-watchdog"
import { formatMissionContractMonitorBlock } from "./team-contract-helpers"
import type { MissionContract } from "../team/mission-contract"
import type { MissionContractID } from "../team/mission-contract.sql"
import type { EngineerID, TeamID } from "../team/types"

const TEAM_ID = "team_monitor_watchdog" as TeamID
const CONTRACT_ID = "contract_watchdog" as MissionContractID

const makeContract = (overrides?: Partial<MissionContract>): MissionContract => ({
  id: CONTRACT_ID,
  teamID: TEAM_ID,
  status: "approved",
  objective: "Ship watchdog monitor",
  successCriteria: ["text", "metadata"],
  constraints: ["no any"],
  nonGoals: ["no ui"],
  humanGates: [],
  currentPhase: "implementation",
  exportPath: ".tmp/team/team_monitor_watchdog/mission.md",
  timeCreated: 1,
  timeUpdated: 2,
  ...overrides,
})

const composeMonitor = (snapshot: SnapshotView, contract: MissionContract | null) => {
  const contractSummary = formatMissionContractMonitorBlock(contract)
  const watchdogSummary = EngineerMemoryWatchdog.formatMonitorBlock(snapshot)
  const blocks = ["Team status", contractSummary.lines.join("\n")]
  if (watchdogSummary.lines.length > 0) blocks.push(watchdogSummary.lines.join("\n"))
  return {
    output: blocks.join("\n"),
    metadata: {
      contract: contractSummary.metadata,
      memoryWatchdog: watchdogSummary.metadata,
    },
  }
}

describe("team monitor watchdog formatting", () => {
  test("includes warning and terminating states in text and metadata", () => {
    const result = composeMonitor(
      {
        enabled: true,
        engineers: [
          {
            teamID: TEAM_ID,
            engineerID: "eng_warning" as EngineerID,
            pid: 101,
            taskID: "task_warning",
            taskTitle: "Warning task",
            state: "warning",
            rssBytes: 7 * 1024 * 1024 * 1024,
            peakRssBytes: 7 * 1024 * 1024 * 1024,
            hardLimitBytes: 12 * 1024 * 1024 * 1024,
            warningLimitBytes: 6 * 1024 * 1024 * 1024,
            sampleKind: "process-tree",
            configSource: "host-aware-default",
            consecutiveLimitBreaches: 1,
          },
          {
            teamID: TEAM_ID,
            engineerID: "eng_terminating" as EngineerID,
            pid: 202,
            taskID: "task_terminating",
            taskTitle: "Terminating task",
            state: "terminating",
            rssBytes: 13 * 1024 * 1024 * 1024,
            peakRssBytes: 13 * 1024 * 1024 * 1024,
            hardLimitBytes: 12 * 1024 * 1024 * 1024,
            warningLimitBytes: 6 * 1024 * 1024 * 1024,
            sampleKind: "process-tree",
            configSource: "env",
            consecutiveLimitBreaches: 2,
          },
        ],
      },
      makeContract(),
    )

    expect(result.output).toContain("Memory Watchdog:")
    expect(result.output).toContain("eng_warning: warning")
    expect(result.output).toContain("eng_terminating: terminating")
    expect(result.metadata.memoryWatchdog).toEqual({
      enabled: true,
      engineers: [
        {
          engineerID: "eng_warning",
          pid: 101,
          state: "warning",
          rssBytes: 7 * 1024 * 1024 * 1024,
          peakRssBytes: 7 * 1024 * 1024 * 1024,
          hardLimitBytes: 12 * 1024 * 1024 * 1024,
          sampleKind: "process-tree",
          configSource: "host-aware-default",
        },
        {
          engineerID: "eng_terminating",
          pid: 202,
          state: "terminating",
          rssBytes: 13 * 1024 * 1024 * 1024,
          peakRssBytes: 13 * 1024 * 1024 * 1024,
          hardLimitBytes: 12 * 1024 * 1024 * 1024,
          sampleKind: "process-tree",
          configSource: "env",
        },
      ],
    })
  })

  test("marks direct PID sampling as best-effort", () => {
    const result = composeMonitor(
      {
        enabled: true,
        engineers: [
          {
            teamID: TEAM_ID,
            engineerID: "eng_best_effort" as EngineerID,
            pid: 303,
            taskID: "task_best_effort",
            taskTitle: "Best effort task",
            state: "monitoring",
            rssBytes: 2 * 1024 * 1024 * 1024,
            peakRssBytes: 2 * 1024 * 1024 * 1024,
            hardLimitBytes: 12 * 1024 * 1024 * 1024,
            warningLimitBytes: 6 * 1024 * 1024 * 1024,
            sampleKind: "direct-pid",
            configSource: "static-default",
            consecutiveLimitBreaches: 0,
          },
        ],
      },
      makeContract(),
    )

    expect(result.output).toContain("best-effort")
  })

  test("empty snapshot keeps metadata but omits noisy output", () => {
    const result = composeMonitor(
      {
        enabled: true,
        engineers: [],
      },
      makeContract(),
    )

    expect(result.output).not.toContain("Memory Watchdog:")
    expect(result.metadata.memoryWatchdog).toEqual({
      enabled: true,
      engineers: [],
    })
  })

  test("mission contract metadata remains unchanged", () => {
    const contract = makeContract()
    const result = composeMonitor({ enabled: false, engineers: [] }, contract)

    expect(result.metadata.contract).toEqual({
      present: true,
      contractID: CONTRACT_ID,
      status: "approved",
      phase: "implementation",
      objective: "Ship watchdog monitor",
      successCriteria: 2,
      humanGates: {
        total: 0,
        pending: 0,
        satisfied: 0,
        waived: 0,
      },
      exportPath: ".tmp/team/team_monitor_watchdog/mission.md",
    })
  })
})
