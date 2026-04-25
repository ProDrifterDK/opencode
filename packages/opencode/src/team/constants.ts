export const MAX_TEAM_SIZE = 5

export const MAX_CONCURRENT_LLM_CALLS = 4

export const ENGINEER_MAX_IDLE = 5 * 60 * 1000

export const ENGINEER_MAX_RUNTIME = 2 * 60 * 60 * 1000

export const MAILBOX_QUEUE_DEPTH = 50

export const LEAD_CONTEXT_BUDGET = 0.6

export const TASK_BOARD_MAX_TASKS = 100

export const HEARTBEAT_INTERVAL = 30 * 1000

// Daemon-level heartbeat sweep constants. Used by both HeartbeatMonitor
// (primary, per-team) and TeamDaemon's setInterval backstop.
export const HEARTBEAT_UPDATE_INTERVAL = 30_000
export const HEARTBEAT_CHECK_INTERVAL = 60_000
export const HEARTBEAT_TIMEOUT = 300_000

export const LEAD_DAEMON_POLL_INTERVAL = 5 * 1000

/**
 * How long the lead waits after sending SIGTERM to an engineer subprocess
 * before escalating to SIGKILL. Engineers should exit promptly on a
 * graceful kill (no in-flight LLM call holds them for long); 5s is enough
 * for Effect finalizers + flushing stdio without leaving zombies.
 * Used by `terminateSubprocess` (Phase 3 of A3).
 */
export const ENGINEER_KILL_TIMEOUT_MS = 5_000

export const GIT_BRANCH_PREFIX = "team"

export const RATE_LIMIT_TOKENS_PER_MIN = 100_000

export const RATE_LIMIT_MAX_CONCURRENT = 4

export const RATE_LIMIT_BASE_BACKOFF_MS = 30_000

export const AUTO_TEAM_ENABLED = process.env.OPENCODE_AUTO_TEAM !== "false"
export const AUTO_TEAM_THRESHOLD = 2
export const AUTO_TEAM_MIN_FILES = 3