---
description: Stop the active team or a specific engineer. Dissolves the entire team by default, or kills a single engineer if an engineer ID is provided.
subtask: false
---

# Team Stop

Stop team execution. This command supports two modes:

## Mode 1: Stop Specific Engineer

If `$ARGUMENTS` contains an engineer ID (format: `eng_*`), stop only that engineer:

1. Use `SessionCoordinator.killEngineer({ engineerID, teamID })` to:
   - Remove the engineer's session
   - Purge their mailbox
   - Update the team's engineer count
   - If this was the last engineer, set the team state to "idle"

2. Reassign any tasks that were assigned to the killed engineer:
   - Find tasks assigned to the engineer using `TaskBoardService.listByEngineer(teamID, engineerID)`
   - Reset those tasks to "pending" status with no assigned engineer
   - Optionally attempt reassignment using `LeadCoordinator.assign()`

3. Display confirmation:
```
Engineer stopped: <engineerID> (<name>)
Reassigned <count> tasks back to pending queue.
Team state: <idle|active> (<remaining> engineers)
```

## Mode 2: Dissolve Entire Team

If `$ARGUMENTS` is empty or does not match an engineer ID, dissolve the entire team:

1. Find the active team by querying `SessionCoordinator.getTeam()` for known team IDs.

2. Use `SessionCoordinator.dissolveTeam({ teamID })` to:
   - Set team state to "dissolving"
   - Kill all engineer sessions and purge their mailboxes
   - Delete all task board entries for the team
   - Remove the team record entirely

3. Display confirmation:
```
Team dissolved: <teamID>
Engineers stopped: <count>
Tasks cleaned up: <count>
```

## Error Handling

- If engineer ID is provided but not found: "Engineer not found: <engineerID>"
- If no active team exists: "No active team to stop."
- If dissolution fails partway through, report which engineers were stopped and which remain.

## Safety

Before dissolving a team with in-progress tasks, confirm with the user if there are tasks in "in-progress" or "blocked" state. Show the count of affected tasks and ask for confirmation.
