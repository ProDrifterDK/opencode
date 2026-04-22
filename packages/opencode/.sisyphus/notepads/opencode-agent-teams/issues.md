# Issues & Gotchas — OpenCode Agent Teams

## 2026-04-22

### No Critical Issues Yet
All Wave 0-3 tasks completed successfully. Tests passing.

### Notes
- T12 Heartbeat timed out during execution but files were created and tests pass (14/14)
- Need to ensure Wave 4 tasks follow same Effect patterns as previous modules
- T14 rate limiter should integrate with existing HeartbeatMonitor.handleRateLimit
- T15 git manager should use Bun APIs where possible per AGENTS.md style guide
- T16 plugin hooks should use existing Bus.publish pattern
