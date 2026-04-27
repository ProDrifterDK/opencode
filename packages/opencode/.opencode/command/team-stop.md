---
description: Stop the active team or a specific engineer. Dissolves the entire team by default, or kills a single engineer if an engineer ID is provided.
subtask: false
---

# Team Stop

Stop team execution using the `team_*` LLM tools. You are the Lead;
only the Lead can kill engineers or dissolve a team.

This command has two modes, chosen by inspecting `$ARGUMENTS`.

## Mode 1: Stop a Single Engineer

If `$ARGUMENTS` matches an engineer ID (format: `eng_*`), call:

```
team_kill({ engineerID: "<eng_...>" })
```

`team_kill` derives the team automatically from the engineer's slot,
releases the engineer's current task back to `pending`, removes the
session, purges the mailbox, and decrements the team's engineer count.
If this was the last engineer, the team state flips to `idle`. The tool
output reports these effects — surface that output to the user. This
replaces the older direct-service call that was documented as
`killEngineer({ engineerID, teamID })`.

Display confirmation based on the tool's output, e.g.:

```
Engineer stopped: <engineerID>
Released <count> tasks back to pending.
Team state: <idle|active> (<remaining> engineers)
```

## Mode 2: Dissolve the Entire Team

If `$ARGUMENTS` is empty or looks like a team ID (format: `tm_*`),
dissolve the whole team.

1. Resolve the team ID:
   - If `$ARGUMENTS` is a team ID, use it.
   - If empty, use the team ID known from this conversation (from the
     most recent `team_create` result).
   - If no team ID is available, tell the user: "No team to stop. Pass
     a team ID: `/team-stop <tm_...>`."

2. Check for in-progress work before dissolving. You can
   call `team_monitor({ teamID })` to get task counts. If `inProgress`
   or `blocked` counts are non-zero, ask the user to confirm before
   proceeding.

3. Call:

```
team_dissolve({ teamID, reason: "<why the team is being stopped>" })
```

`team_dissolve` sets state to `dissolving`, kills all engineers, purges
their mailboxes, archives task board entries for later summaries, and cleans
up team git branches (via `GitManager.cleanupBranches`). This replaces the
older `dissolveTeam({ teamID })` service call.

If the tool refuses because tasks are still in progress, use the tool's error
message verbatim and either wait for completion or explicitly stop engineers
first. Do not try to batch-kill engineers manually as a workaround.

Display confirmation based on the tool's output, e.g.:

```
Team dissolved: <teamID>
Engineers stopped: <count>
Branches cleaned: <yes|no>
```

## Error Handling

- `Engineer not found`: the engineer ID was wrong or already killed —
  tell the user and stop.
- `Only the lead can …`: this session is not the Lead — tell the user.
- `Cannot dissolve: N tasks in progress`: tell the user the count and
  either wait for completion or stop specific engineers first.

## Safety

Dissolving a team terminates live engineer processes and archives the board.
When in-progress tasks exist, confirm with the user before killing engineers —
their in-progress work will be marked `failed` and the engineers terminated
mid-execution.
