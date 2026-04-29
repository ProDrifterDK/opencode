import * as fs from "node:fs/promises"
import { Log } from "@/util"
import type { EngineerID, TeamID } from "./types"

const log = Log.create({ service: "team.engineer-memory-watchdog" })

const MB = 1024 * 1024
const GIB = 1024 * 1024 * 1024
const DEFAULT_WARN_MB = 6_144
const DEFAULT_HARD_MB = 12_288
const DEFAULT_POLL_MS = 5_000
const DEFAULT_BREACHES = 2

export type WatchState = "monitoring" | "warning" | "terminating" | "stopped" | "unsupported"
export type SampleKind = "process-tree" | "direct-pid" | "unsupported"
export type ConfigSource = "env" | "host-aware-default" | "static-default"

export interface WatchdogConfig {
  enabled: boolean
  warningLimitBytes: number
  hardLimitBytes: number
  pollMs: number
  requiredBreaches: number
  configSource: ConfigSource
}

export interface WatchSnapshot {
  teamID: TeamID
  engineerID: EngineerID
  pid: number
  taskID: string
  taskTitle: string
  state: WatchState
  rssBytes?: number
  peakRssBytes?: number
  hardLimitBytes: number
  warningLimitBytes: number
  sampleKind: SampleKind
  configSource: ConfigSource
  consecutiveLimitBreaches: number
  lastSampleAt?: number
}

export interface SnapshotView {
  enabled: boolean
  engineers: WatchSnapshot[]
}

export interface MonitorMetadata {
  enabled: boolean
  engineers: Array<{
    engineerID: string
    pid: number
    state: WatchState
    rssBytes?: number
    peakRssBytes?: number
    hardLimitBytes?: number
    sampleKind?: SampleKind
    configSource?: ConfigSource
  }>
}

export interface MonitorBlock {
  lines: string[]
  metadata: MonitorMetadata
}

type SampleResult =
  | {
      state: "sampled"
      rssBytes: number
      sampleKind: Exclude<SampleKind, "unsupported">
    }
  | {
      state: "unsupported"
      sampleKind: "unsupported"
      reason: string
    }

export interface SamplerDeps {
  platform?: NodeJS.Platform
  procRoot?: string
  listDirectory?: (path: string) => Promise<string[]>
  readFile?: (path: string) => Promise<string>
  runPs?: (pid: number) => Promise<number | null>
}

export interface StartInput {
  teamID: TeamID
  engineerID: EngineerID
  rootPid: number
  taskID: string
  taskTitle: string
  env?: Record<string, string | undefined>
  hostTotalMemoryBytes?: number | null
  sampler?: (pid: number) => Promise<SampleResult>
  onTerminate: (snapshot: WatchSnapshot) => Promise<void> | void
  scheduler?: {
    setInterval: (callback: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  runImmediately?: boolean
}

type ActiveWatch = WatchSnapshot & {
  timer: unknown
  ticking: boolean
  terminateRequested: boolean
  sampler: (pid: number) => Promise<SampleResult>
  onTerminate: (snapshot: WatchSnapshot) => Promise<void> | void
  clearInterval: (handle: unknown) => void
}

const watches = new Map<string, ActiveWatch>()

const watchKey = (teamID: TeamID, engineerID: EngineerID) => `${teamID}:${engineerID}`

const defaultScheduler = {
  setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
}

const readPositiveInteger = (raw: string | undefined) => {
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const parseEnabled = (raw: string | undefined, fallback: boolean) => {
  if (raw === undefined) return fallback
  if (raw === "1") return true
  if (raw === "0") return false
  log.warn("invalid watchdog enabled flag, using fallback", { raw })
  return fallback
}

const clampDefaultBytes = (staticMb: number, ratio: number, hostTotalMemoryBytes?: number | null) => {
  if (!hostTotalMemoryBytes || hostTotalMemoryBytes <= 0) return staticMb * MB
  return Math.min(staticMb * MB, Math.floor((hostTotalMemoryBytes * ratio) / MB) * MB)
}

export function readConfig(input: {
  env?: Record<string, string | undefined>
  hostTotalMemoryBytes?: number | null
  defaultEnabled?: boolean
} = {}): WatchdogConfig {
  const env = input.env ?? process.env
  const defaultEnabled = input.defaultEnabled ?? true
  const enabled = parseEnabled(env.OPENCODE_TEAM_ENGINEER_MEMORY_WATCHDOG, defaultEnabled)
  const defaultWarningLimitBytes = clampDefaultBytes(DEFAULT_WARN_MB, 0.25, input.hostTotalMemoryBytes)
  const defaultHardLimitBytes = clampDefaultBytes(DEFAULT_HARD_MB, 0.5, input.hostTotalMemoryBytes)
  const warningMb = readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB)
  const hardMb = readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB)
  const pollMs = readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS) ?? DEFAULT_POLL_MS
  const requiredBreaches = readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES) ?? DEFAULT_BREACHES
  const warningLimitBytes = warningMb ? warningMb * MB : defaultWarningLimitBytes
  const hardLimitBytes = hardMb ? hardMb * MB : defaultHardLimitBytes
  const orderedHardLimitBytes = Math.max(hardLimitBytes, warningLimitBytes)
  const configSource: ConfigSource =
    warningMb || hardMb || env.OPENCODE_TEAM_ENGINEER_MEMORY_WATCHDOG !== undefined
      ? "env"
      : input.hostTotalMemoryBytes
        ? "host-aware-default"
        : "static-default"

  if (env.OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB && !warningMb) {
    log.warn("invalid watchdog warning limit, using default", {
      raw: env.OPENCODE_TEAM_ENGINEER_MEMORY_WARN_MB,
    })
  }
  if (env.OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB && !hardMb) {
    log.warn("invalid watchdog hard limit, using default", {
      raw: env.OPENCODE_TEAM_ENGINEER_MEMORY_LIMIT_MB,
    })
  }
  if (env.OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS && !readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS)) {
    log.warn("invalid watchdog poll interval, using default", {
      raw: env.OPENCODE_TEAM_ENGINEER_MEMORY_POLL_MS,
    })
  }
  if (env.OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES && !readPositiveInteger(env.OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES)) {
    log.warn("invalid watchdog breach count, using default", {
      raw: env.OPENCODE_TEAM_ENGINEER_MEMORY_BREACHES,
    })
  }

  return {
    enabled,
    warningLimitBytes,
    hardLimitBytes: orderedHardLimitBytes,
    pollMs,
    requiredBreaches,
    configSource,
  }
}

const defaultReadFile = (filePath: string) => fs.readFile(filePath, "utf8")
const defaultListDirectory = (dirPath: string) => fs.readdir(dirPath)

const parseProcStatus = (content: string) => {
  let pid: number | undefined
  let ppid: number | undefined
  let rssBytes = 0

  for (const line of content.split("\n")) {
    if (line.startsWith("Pid:")) {
      const value = Number.parseInt(line.slice(4).trim(), 10)
      if (Number.isFinite(value)) pid = value
      continue
    }
    if (line.startsWith("PPid:")) {
      const value = Number.parseInt(line.slice(5).trim(), 10)
      if (Number.isFinite(value)) ppid = value
      continue
    }
    if (line.startsWith("VmRSS:")) {
      const value = Number.parseInt(line.slice(6).trim(), 10)
      if (Number.isFinite(value)) rssBytes = value * 1024
    }
  }

  return pid !== undefined && ppid !== undefined ? { pid, ppid, rssBytes } : null
}

const defaultRunPs = async (pid: number) => {
  const subprocess = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(subprocess.stdout).text()
  await subprocess.exited
  const rssKb = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(rssKb) ? rssKb * 1024 : null
}

export async function sampleProcessTreeRss(rootPid: number, deps: SamplerDeps = {}): Promise<SampleResult> {
  const platform = deps.platform ?? process.platform
  const procRoot = deps.procRoot ?? "/proc"
  const readFile = deps.readFile ?? defaultReadFile
  const listDirectory = deps.listDirectory ?? defaultListDirectory
  const runPs = deps.runPs ?? defaultRunPs

  if (platform === "linux") {
    try {
      const entries = await listDirectory(procRoot)
      const numericEntries = entries.filter((entry) => /^\d+$/.test(entry))
      const statuses = await Promise.all(
        numericEntries.map(async (entry) => {
          try {
            const parsed = parseProcStatus(await readFile(`${procRoot}/${entry}/status`))
            return parsed
          } catch {
            return null
          }
        }),
      )
      const processTable = statuses.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      const root = processTable.find((entry) => entry.pid === rootPid)
      if (root) {
        const childMap = new Map<number, number[]>()
        for (const entry of processTable) {
          const siblings = childMap.get(entry.ppid) ?? []
          siblings.push(entry.pid)
          childMap.set(entry.ppid, siblings)
        }
        let rssBytes = 0
        const queue = [rootPid]
        const seen = new Set<number>()
        while (queue.length > 0) {
          const pid = queue.shift()!
          if (seen.has(pid)) continue
          seen.add(pid)
          const entry = processTable.find((candidate) => candidate.pid === pid)
          if (entry) rssBytes += entry.rssBytes
          for (const child of childMap.get(pid) ?? []) queue.push(child)
        }
        return {
          state: "sampled",
          rssBytes,
          sampleKind: "process-tree",
        }
      }
    } catch (error) {
      log.debug("/proc sampling unavailable, falling back to direct pid", {
        rootPid,
        error: String(error),
      })
    }
  }

  try {
    const rssBytes = await runPs(rootPid)
    if (rssBytes !== null) {
      return {
        state: "sampled",
        rssBytes,
        sampleKind: "direct-pid",
      }
    }
  } catch (error) {
    log.debug("ps sampling unavailable", { rootPid, error: String(error) })
  }

  return {
    state: "unsupported",
    sampleKind: "unsupported",
    reason: "memory sampling unsupported",
  }
}

const cloneSnapshot = (watch: ActiveWatch): WatchSnapshot => ({
  teamID: watch.teamID,
  engineerID: watch.engineerID,
  pid: watch.pid,
  taskID: watch.taskID,
  taskTitle: watch.taskTitle,
  state: watch.state,
  rssBytes: watch.rssBytes,
  peakRssBytes: watch.peakRssBytes,
  hardLimitBytes: watch.hardLimitBytes,
  warningLimitBytes: watch.warningLimitBytes,
  sampleKind: watch.sampleKind,
  configSource: watch.configSource,
  consecutiveLimitBreaches: watch.consecutiveLimitBreaches,
  lastSampleAt: watch.lastSampleAt,
})

const detectHostTotalMemoryBytes = async (readFile: (path: string) => Promise<string> = defaultReadFile) => {
  if (process.platform !== "linux") return null
  try {
    const meminfo = await readFile("/proc/meminfo")
    const line = meminfo
      .split("\n")
      .find((entry) => entry.startsWith("MemTotal:"))
    if (!line) return null
    const memKb = Number.parseInt(line.replace(/\D+/g, " ").trim(), 10)
    return Number.isFinite(memKb) ? memKb * 1024 : null
  } catch {
    return null
  }
}

export async function start(input: StartInput): Promise<void> {
  const key = watchKey(input.teamID, input.engineerID)
  stop(input.teamID, input.engineerID)

  const config = readConfig({
    env: input.env,
    hostTotalMemoryBytes: input.hostTotalMemoryBytes ?? (await detectHostTotalMemoryBytes()),
  })
  if (!config.enabled) return

  const scheduler = input.scheduler ?? defaultScheduler
  const sampler = input.sampler ?? ((pid: number) => sampleProcessTreeRss(pid))
  const watch: ActiveWatch = {
    teamID: input.teamID,
    engineerID: input.engineerID,
    pid: input.rootPid,
    taskID: input.taskID,
    taskTitle: input.taskTitle,
    state: "monitoring",
    hardLimitBytes: config.hardLimitBytes,
    warningLimitBytes: config.warningLimitBytes,
    configSource: config.configSource,
    sampleKind: "process-tree",
    consecutiveLimitBreaches: 0,
    lastSampleAt: undefined,
    rssBytes: undefined,
    peakRssBytes: undefined,
    timer: undefined,
    ticking: false,
    terminateRequested: false,
    sampler,
    onTerminate: input.onTerminate,
    clearInterval: scheduler.clearInterval,
  }

  const tick = async () => {
    const current = watches.get(key)
    if (!current || current.ticking || current.terminateRequested) return
    current.ticking = true

    try {
      const sample = await current.sampler(current.pid)
      const live = watches.get(key)
      if (!live) return

      live.lastSampleAt = Date.now()

      if (sample.state === "unsupported") {
        live.state = "unsupported"
        live.sampleKind = "unsupported"
        live.consecutiveLimitBreaches = 0
        return
      }

      live.sampleKind = sample.sampleKind
      live.rssBytes = sample.rssBytes
      live.peakRssBytes = Math.max(live.peakRssBytes ?? 0, sample.rssBytes)
      live.consecutiveLimitBreaches =
        sample.rssBytes >= live.hardLimitBytes
          ? live.consecutiveLimitBreaches + 1
          : 0

      if (sample.rssBytes >= live.warningLimitBytes) {
        live.state = "warning"
      } else {
        live.state = "monitoring"
      }

      if (sample.rssBytes < live.hardLimitBytes || live.consecutiveLimitBreaches < config.requiredBreaches) {
        return
      }

      live.state = "terminating"
      live.terminateRequested = true
      await live.onTerminate(cloneSnapshot(live))
    } catch (error) {
      const live = watches.get(key)
      if (!live) return
      live.state = "unsupported"
      live.sampleKind = "unsupported"
      live.consecutiveLimitBreaches = 0
      log.warn("watchdog tick failed", {
        engineerID: input.engineerID,
        teamID: input.teamID,
        error: String(error),
      })
    } finally {
      const live = watches.get(key)
      if (live) live.ticking = false
    }
  }

  watch.timer = scheduler.setInterval(() => {
    void tick()
  }, config.pollMs)
  watches.set(key, watch)

  if (input.runImmediately ?? true) {
    void tick()
  }
}

export function stop(teamID: TeamID, engineerID: EngineerID): void {
  const key = watchKey(teamID, engineerID)
  const watch = watches.get(key)
  if (!watch) return
  watch.state = "stopped"
  watch.clearInterval(watch.timer)
  watches.delete(key)
}

export function stopAll(): void {
  for (const watch of watches.values()) {
    watch.state = "stopped"
    watch.clearInterval(watch.timer)
  }
  watches.clear()
}

export function getSnapshot(teamID?: TeamID): SnapshotView {
  const engineers = [...watches.values()]
    .filter((watch) => !teamID || watch.teamID === teamID)
    .sort((a, b) => a.engineerID.localeCompare(b.engineerID))
    .map(cloneSnapshot)

  return {
    enabled: readConfig().enabled,
    engineers,
  }
}

const formatBytes = (bytes?: number) => {
  if (bytes === undefined) return "unknown"
  return `${(bytes / GIB).toFixed(1)} GiB`
}

export function formatMonitorBlock(snapshot: SnapshotView): MonitorBlock {
  const metadata: MonitorMetadata = {
    enabled: snapshot.enabled,
    engineers: snapshot.engineers.map((engineer) => ({
      engineerID: engineer.engineerID,
      pid: engineer.pid,
      state: engineer.state,
      rssBytes: engineer.rssBytes,
      peakRssBytes: engineer.peakRssBytes,
      hardLimitBytes: engineer.hardLimitBytes,
      sampleKind: engineer.sampleKind,
      configSource: engineer.configSource,
    })),
  }

  const hasInterestingState = snapshot.engineers.some((engineer) => engineer.state !== "monitoring")
  if (snapshot.engineers.length === 0 || (!snapshot.enabled && !hasInterestingState)) {
    return { lines: [], metadata }
  }

  const lines = ["Memory Watchdog:"]
  for (const engineer of snapshot.engineers) {
    if (engineer.state === "unsupported") {
      lines.push(`  ${engineer.engineerID}: unsupported — sampling unavailable, pid ${engineer.pid}`)
      continue
    }

    lines.push(
      `  ${engineer.engineerID}: ${engineer.state} — RSS ${formatBytes(engineer.rssBytes)} / ${formatBytes(engineer.hardLimitBytes)}, peak ${formatBytes(engineer.peakRssBytes)}, pid ${engineer.pid}`,
    )
  }

  if (snapshot.engineers.some((engineer) => engineer.sampleKind === "direct-pid" || engineer.sampleKind === "unsupported")) {
    lines.push("  Note: direct PID / unsupported sampling is best-effort and may miss child-process RSS.")
  }

  return { lines, metadata }
}

export * as EngineerMemoryWatchdog from "./engineer-memory-watchdog"
