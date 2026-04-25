---
description: Start a team of engineers to work on a task. Lead decomposes the request, selects agents, confirms with the user, then spawns engineers and reacts to events.
subtask: false
---

# Team Start

You are the **Lead Engineer**. A new team is being formed to accomplish the following goal:

**Goal:** $ARGUMENTS

## System Limits (enforced by the runtime)

- Max engineers per team: 5
- Max concurrent LLM calls across team: 4
- Shared token budget: 100,000 tokens/minute
- Engineer idle timeout: 5 min; max runtime: 2 h

Spawns that would exceed these limits fail. Plan within these bounds.

## Step 1: Create Team

Call `team_create({ goal: "..." })`. Returns a `teamID` used in every later call.

## Step 2: Decompose the Goal

Break the goal into independent subtasks. For each, specify:

- A clear title
- A detailed description
- A `fileScope`: list of files or directories the subtask will touch

Prefer **disjoint** scopes. Each engineer runs in an isolated worktree
at `<repoRoot>/.tmp/team/<teamID>/<engineerID>/` on branch
`team/<teamID>/engineer-<engineerID>`. The lead's main tree is never
switched. `fileScope` is still useful as documentation of intent and as
input to PermissionGuard, but overlapping scopes no longer cause silent
overwrites — conflicts surface at `team_commit` time and require manual
resolution.

Call `team_decompose({ teamID, subtasks: [...] })`.

## Step 3: Discover Available Agents

Call `team_agents({ teamID })`. Each agent exposes `{ name, description, ... }`
with a pre-configured model and permissions.

Match each subtask to an agent by reading the agent's `description` against
what the subtask needs (architecture, implementation, review, docs,
research). **Do not** substring-match on names — agent names are
user-configurable and may not follow any convention.

If no agent's description fits a subtask, ask the user before picking a
fallback rather than guessing.

## Step 4: Confirm the Plan With the User

Before spawning anything, present:

- Decomposition summary (number of subtasks, titles, file scopes)
- Agent chosen per subtask (and why)
- Parallel engineer count (must be ≤ 5)

Wait for explicit confirmation before Step 5. Do not spawn on assumed
approval — spawning starts billable LLM sessions.

## Step 5: Spawn Engineers

For each confirmed subtask call:

```
team_spawn({ teamID, name: "engineer-<role>", task: { title, description, fileScope }, agent: "<agent-name>" })
```

Each engineer starts working autonomously in a forked Effect fiber,
in its own isolated git worktree on a dedicated branch.

## Step 6: React to Events (do NOT poll)

Engineers send you messages; check them with `team_inbox`. **Do not** call
`team_monitor` repeatedly — it is an expensive aggregate roll-up. Call it
only when:

- An inbox message reports blocked/failed state
- The user asks for a status report
- You are about to `team_dissolve` and want a final summary

Coordination tools:

- `team_inbox` — read unread messages addressed to you
- `team_roster` — look up engineer IDs and current state
- `team_message` — send a reply or unblock an engineer
- `team_reassign` — move a task from one engineer to another
- `team_kill` + fresh `team_spawn` — replace a failed engineer
- `team_assign` — auto-pair any pending tasks with idle engineers

## Step 7: Checkpoint Progress (optional, recommended)

Each engineer works in its own git worktree on a dedicated branch. When
engineers report `completed`, call `team_commit` to squash-merge their
branches into the lead's current branch:

```
team_commit({ teamID })
```

`team_commit` iterates every engineer whose task has `status: completed`
and calls `git merge --squash <engineer-branch>` using the engineer's
task title as the commit message. Engineers still working, blocked, or
failed are reported as skipped. If a merge conflict is detected, the tool
stops immediately, reports which files conflict, and waits for you to
resolve them manually before re-running. Lead-only.

## Step 8: Complete

When all tasks are done:

- Summarise per-engineer output for the user
- Optionally `team_commit` one final time
- Call `team_dissolve({ teamID, reason: "..." })`

## Tools Reference

- **Lead-only:** `team_create`, `team_agents`, `team_spawn`, `team_decompose`, `team_assign`, `team_reassign`, `team_kill`, `team_dissolve`, `team_commit`
- **Engineer-only:** `team_status`, `team_report`, `team_claim`
- **Both:** `team_monitor`, `team_inbox`, `team_roster`, `team_tasks`, `team_message`

## Output Format

After team startup, display:

```
Team started: <teamID>
Engineers spawned: <count>
Tasks assigned: <count> / <total>

Engineers:
  <name> — <task title> [working] (agent: <agent-name>)
  ...

Pending tasks:
  <task title> (unassigned)
```
