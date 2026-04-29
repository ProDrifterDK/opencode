import { beforeEach, describe, expect, test } from "bun:test"
import {
  EngineerMemoryWatchdog,
  type SnapshotView,
} from "./engineer-memory-watchdog"
import type { EngineerID, TeamID } from "./types"

const TEAM_ID = "team_watchdog" as TeamID
const ENGINEER_ID = "eng_watchdog" as EngineerID
const HARD_LIMIT_MB = 32
const WARNING_LIMIT_MB = 16
const MB = 1024 * 1024

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const makeScheduler = () => {
  const callbacks: Array<() => void> = []
  const cleared: unknown[] = []
  return {
    scheduler: {
      setInterval: (callback: () => void) => {
        callbacks.push(callback)
        return callback
      },
      clearInterval: (handle: unknown) => {
        cleared.push(handle)
      },
    },
    tick: async (index = 0) => {
      callbacks[index]?.()
      await flush()
    },
    cleared,
  }
}

const getEngineerSnapshot = () => {
  const snapshot = EngineerMemoryWatchdog.getSnapshot(TEAM_ID)
  return snapshot.engineers[0]
}

beforeEach(() => {
  EngineerMemoryWatchdog.stopAll()
})

describe("EngineerMemoryWatchdog.readConfig", () => {
  test("accepts valid env values and falls back on invalid values", () => {
    const valid = EngineerMemoryWatchdog.readConfig({
      env: {
        OPENCODE_TEAM_ENGINEER_MEMORY_WATCHDOG: "1",
        OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB: "24",
        OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB: "48",
        OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS: "1234",
        OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES: "3",
      },
    })

    expect(valid.enabled).toBe(true)
    expect(valid.warningLimitBytes).toBe(24 * MB)
    expect(valid.hardLimitBytes).toBe(48 * MB)
    expect(valid.pollMs).toBe(1234)
    expect(valid.requiredBreaches).toBe(3)
    expect(valid.configSource).toBe("env")

    const fallback = EngineerMemoryWatchdog.readConfig({
      env: {
        OPENCODE_TEAM_ENGINEER_MEMORY_WATCHDOG: "wat",
        OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB: "nope",
        OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB: "also-nope",
        OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS: "bad",
        OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES: "bad",
      },
    })

    expect(fallback.enabled).toBe(true)
    expect(fallback.warningLimitBytes).toBe(6144 * MB)
    expect(fallback.hardLimitBytes).toBe(12288 * MB)
    expect(fallback.pollMs).toBe(5000)
    expect(fallback.requiredBreaches).toBe(2)
  })

  test("host-aware defaults clamp below static defaults on a small host", () => {
    const config = EngineerMemoryWatchdog.readConfig({
      hostTotalMemoryBytes: 8 * 1024 * 1024 * 1024,
    })

    expect(config.warningLimitBytes).toBe(2 * 1024 * 1024 * 1024)
    expect(config.hardLimitBytes).toBe(4 * 1024 * 1024 * 1024)
    expect(config.configSource).toBe("host-aware-default")
  })
})

describe("EngineerMemoryWatchdog.sampleProcessTreeRss", () => {
  test("sums root plus descendants and excludes unrelated processes", async () => {
    const proc = new Map<string, string>([
      ["/fake-proc/100/status", "Pid:\t100\nPPid:\t1\nVmRSS:\t1000 kB\n"],
      ["/fake-proc/200/status", "Pid:\t200\nPPid:\t100\nVmRSS:\t2000 kB\n"],
      ["/fake-proc/300/status", "Pid:\t300\nPPid:\t200\nVmRSS:\t3000 kB\n"],
      ["/fake-proc/400/status", "Pid:\t400\nPPid:\t1\nVmRSS:\t4000 kB\n"],
    ])

    const sample = await EngineerMemoryWatchdog.sampleProcessTreeRss(100, {
      platform: "linux",
      procRoot: "/fake-proc",
      listDirectory: async () => ["100", "200", "300", "400"],
      readFile: async (filePath) => {
        const content = proc.get(filePath)
        if (!content) throw new Error(`missing fixture: ${filePath}`)
        return content
      },
    })

    expect(sample).toEqual({
      state: "sampled",
      rssBytes: (1000 + 2000 + 3000) * 1024,
      sampleKind: "process-tree",
    })
  })

  test("falls back to direct PID sampling when /proc is unavailable", async () => {
    const sample = await EngineerMemoryWatchdog.sampleProcessTreeRss(321, {
      platform: "darwin",
      runPs: async () => 9 * MB,
    })

    expect(sample).toEqual({
      state: "sampled",
      rssBytes: 9 * MB,
      sampleKind: "direct-pid",
    })
  })

  test("returns unsupported when no sampling strategy works", async () => {
    const sample = await EngineerMemoryWatchdog.sampleProcessTreeRss(321, {
      platform: "darwin",
      runPs: async () => null,
    })

    expect(sample.state).toBe("unsupported")
    expect(sample.sampleKind).toBe("unsupported")
  })
})

describe("EngineerMemoryWatchdog runtime", () => {
  test("warning threshold updates state and peak RSS without terminating", async () => {
    const { scheduler, tick } = makeScheduler()
    const terminations: SnapshotView["engineers"] = []

    await EngineerMemoryWatchdog.start({
      teamID: TEAM_ID,
      engineerID: ENGINEER_ID,
      rootPid: 123,
      taskID: "task_warning",
      taskTitle: "Warning task",
      env: {
        OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB: String(WARNING_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB: String(HARD_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES: "2",
      },
      scheduler,
      runImmediately: false,
      sampler: async () => ({
        state: "sampled",
        rssBytes: 20 * MB,
        sampleKind: "process-tree",
      }),
      onTerminate: (snapshot) => {
        terminations.push(snapshot)
      },
    })

    await tick()

    const snapshot = getEngineerSnapshot()
    expect(snapshot?.state).toBe("warning")
    expect(snapshot?.rssBytes).toBe(20 * MB)
    expect(snapshot?.peakRssBytes).toBe(20 * MB)
    expect(terminations).toHaveLength(0)
  })

  test("unsupported sampling marks state unsupported and does not terminate", async () => {
    const { scheduler, tick } = makeScheduler()
    let terminated = false

    await EngineerMemoryWatchdog.start({
      teamID: TEAM_ID,
      engineerID: ENGINEER_ID,
      rootPid: 123,
      taskID: "task_unsupported",
      taskTitle: "Unsupported task",
      scheduler,
      runImmediately: false,
      sampler: async () => ({
        state: "unsupported",
        sampleKind: "unsupported",
        reason: "no sampler",
      }),
      onTerminate: () => {
        terminated = true
      },
    })

    await tick()

    expect(getEngineerSnapshot()?.state).toBe("unsupported")
    expect(getEngineerSnapshot()?.sampleKind).toBe("unsupported")
    expect(terminated).toBe(false)
  })

  test("hard threshold requires configured consecutive breaches", async () => {
    const { scheduler, tick } = makeScheduler()
    const terminations: SnapshotView["engineers"] = []
    const rssSequence = [33 * MB, 33 * MB]

    await EngineerMemoryWatchdog.start({
      teamID: TEAM_ID,
      engineerID: ENGINEER_ID,
      rootPid: 123,
      taskID: "task_hard_limit",
      taskTitle: "Hard limit task",
      env: {
        OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB: String(WARNING_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB: String(HARD_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES: "2",
      },
      scheduler,
      runImmediately: false,
      sampler: async () => ({
        state: "sampled",
        rssBytes: rssSequence.shift() ?? 33 * MB,
        sampleKind: "process-tree",
      }),
      onTerminate: (snapshot) => {
        terminations.push(snapshot)
      },
    })

    await tick()
    expect(getEngineerSnapshot()?.state).toBe("warning")
    expect(terminations).toHaveLength(0)

    await tick()
    expect(getEngineerSnapshot()?.state).toBe("terminating")
    expect(terminations).toHaveLength(1)
    expect(terminations[0]?.consecutiveLimitBreaches).toBe(2)
  })

  test("overlapping ticks terminate at most once", async () => {
    const { scheduler, tick } = makeScheduler()
    const terminations: SnapshotView["engineers"] = []
    let resolveSampler: ((value: { state: "sampled"; rssBytes: number; sampleKind: "process-tree" }) => void) | undefined

    await EngineerMemoryWatchdog.start({
      teamID: TEAM_ID,
      engineerID: ENGINEER_ID,
      rootPid: 123,
      taskID: "task_overlap",
      taskTitle: "Overlap task",
      env: {
        OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB: String(WARNING_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB: String(HARD_LIMIT_MB),
        OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES: "1",
      },
      scheduler,
      runImmediately: false,
      sampler: () =>
        new Promise((resolve) => {
          resolveSampler = resolve
        }),
      onTerminate: (snapshot) => {
        terminations.push(snapshot)
      },
    })

    const firstTick = tick()
    const secondTick = tick()
    resolveSampler?.({
      state: "sampled",
      rssBytes: 40 * MB,
      sampleKind: "process-tree",
    })

    await firstTick
    await secondTick

    expect(terminations).toHaveLength(1)
  })

  test("stopAll clears active watches and timers", async () => {
    const { scheduler, cleared } = makeScheduler()

    await EngineerMemoryWatchdog.start({
      teamID: TEAM_ID,
      engineerID: ENGINEER_ID,
      rootPid: 123,
      taskID: "task_stop_all",
      taskTitle: "Stop task",
      scheduler,
      runImmediately: false,
      sampler: async () => ({
        state: "sampled",
        rssBytes: 8 * MB,
        sampleKind: "process-tree",
      }),
      onTerminate: () => {},
    })

    EngineerMemoryWatchdog.stopAll()

    expect(EngineerMemoryWatchdog.getSnapshot(TEAM_ID).engineers).toHaveLength(0)
    expect(cleared).toHaveLength(1)
  })
})
