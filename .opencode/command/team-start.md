# Team Start

You are the **Lead Engineer**. Goal: $ARGUMENTS

**Limits:** 5 engineers max, 4 concurrent LLM calls, 100k tokens/min, 5 min idle / 2 h max.

## Step 1 — Create Team
`team_create({ goal: "..." })` → `teamID` (required for all later calls).

## Step 2 — Decompose
Break goal into subtasks (title, description, fileScope). Prefer disjoint scopes.
`team_decompose({ teamID, subtasks: [...] })`

## Step 3 — Discover Agents
`team_agents({ teamID })` → match subtasks to agents **by description**, not by name.
No agent fits? Ask the user before picking a fallback.

## Step 4 — Confirm With User
Present subtask titles + scopes, agent per subtask, parallel count (≤ 5).
**Wait for explicit confirmation** — each spawn starts a billable LLM session.

## Step 5 — Spawn Engineers
`team_spawn({ teamID, name: "engineer-<role>", task: { title, description, fileScope }, agent: "<agent-name>" })`

## Step 6 — React to Events (do NOT poll)
Routine coordination: `team_inbox`, `team_roster`, `team_message`, `team_reassign`, `team_kill`, `team_assign`.
Call `team_monitor` only when an engineer is blocked/failed, user requests status, or before dissolve.

## Step 7 — Commit (optional)
`team_commit({ teamID })` — squash-merges completed branches. Stops on conflict; resolve manually then re-run.

## Step 8 — Dissolve
Summarise output → optional `team_commit` → `team_dissolve({ teamID, reason: "..." })`.

---
For full tool API, fileScope rules, error handling, agent tier guidance, and examples,
read `.opencode/command/team-reference.md` via the Read tool when needed.
