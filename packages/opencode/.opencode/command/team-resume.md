---
description: Resume a team that was left in `terminated` state. Re-spawns engineer subprocesses for active tasks and resets in-progress tasks back to pending.
subtask: false
---

# Team Resume

Resume a team that's in `terminated` state. The team's task board, engineer history,
and worktrees are preserved. Engineers are re-spawned as fresh subprocesses; any
in-progress tasks are reset to pending so they can be re-claimed.

Usage: /team-resume <teamID>

This calls `team_resume(teamID)` internally.

## When to use

- A previous `opencode` process exited (SIGINT/SIGTERM/crash) before the team
  was dissolved. The team row was flipped to `terminated` by the graceful
  shutdown handler, but the task board, engineer slots, and git worktrees
  are still intact on disk.
- You want to pick up where the prior run left off without re-decomposing
  or re-spawning from scratch.

## Behavior

1. Verifies the team exists and is in `terminated` state. Teams in `idle`,
   `active`, `dissolving`, or already-deleted (`dissolved`) states are
   rejected with a clear error.
2. Flips the team back to `active`.
3. Resets any tasks left in `in-progress` back to `pending` (their owning
   engineer subprocess died with the previous daemon).
4. Re-attaches the heartbeat monitor (idempotent).
5. Re-spawns subprocesses for engineers still in `working`/`blocked` state
   on disk. `failed` and `idle` engineers are left alone.

## Output

```
Team <teamID> resumed.
Engineers re-spawned: <N>
Tasks reset to pending: <M>
Total engineer slots: <K>
```

## Errors

- `Cannot resume team in state X. Only terminated teams can be resumed.` —
  The team is not in `terminated` state. Inspect with `/team-status` or
  `team_monitor` first.
- `Team not found: ...` — The team ID does not exist (or has already been
  fully dissolved).

## Safety

Resume re-spawns engineer subprocesses. Each spawn starts a billable LLM
session, the same way `team_spawn` does. Make sure you intend to continue
the team's work before resuming.
