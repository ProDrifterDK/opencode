/**
 * Engineer loop - the body that runs INSIDE an engineer subprocess.
 *
 * Phase 1 of A3 (subprocess-per-engineer):
 *   - This was previously inlined inside `daemon.ts` as
 *     `createEngineerLoopEffect`, forked as an Effect fiber inside the
 *     lead's process. It is now a free-standing Effect that the new
 *     `opencode team-engineer-run` CLI subcommand executes inside its
 *     own subprocess. The lead spawns that subprocess via
 *     `EngineerProcessManager.spawn`.
 *
 *   - The loop's behavior is unchanged from Phase 0: acquire a
 *     rate-limit slot, send the engineer prompt, run the prompt loop,
 *     publish team events, and release the slot on exit.
 *
 * Phase 2 wired `publishTeamEvent` to write JSON-line events to stdout
 * via `events.ts`; the lead reads them via `engineer-event-reader.ts`
 * and mirrors them onto its own bus.
 */
import { Effect } from "effect"
import { Log } from "@/util"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Event, publishTeamEvent } from "./events"
import { RateLimiter } from "./rate-limiter"
import type { EngineerID, TeamID } from "./types"
import { deleteRunning } from "./daemon-running"

const log = Log.create({ service: "team.engineer-loop" })

// Rough token estimate per engineer lifetime. Used only as a budget hint
// for the rate limiter's per-minute token window — the exact number matters
// less than the fact that we reserve *some* budget so N engineers can't
// spawn unlimited LLM traffic. If we ever get real token accounting back
// from the LLM service, pass it to release() instead.
export const ENGINEER_TOKEN_ESTIMATE = 8000

export interface EngineerLoopInput {
  teamID: string
  engineerID: string
  sessionID: SessionID
  name: string
  taskId: string
  taskTitle: string
  taskDescription: string
  providerID?: string
  modelID?: string
  teammates?: Array<{ name: string; engineerID: string; task?: string }>
}

/**
 * Run the engineer loop end-to-end. Identical to the legacy
 * `createEngineerLoopEffect` body — extracted so the new CLI subcommand
 * (which runs inside the engineer's own subprocess) can call it.
 */
export const runEngineerLoop = (input: EngineerLoopInput) =>
  Effect.gen(function* () {
    const rateLimiter = yield* RateLimiter.Service
    const promptService = yield* SessionPrompt.Service

    log.info("starting engineer loop", {
      engineerID: input.engineerID,
      sessionID: input.sessionID,
      model: input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : "(default)",
    })

    // Acquire a rate-limit slot. Blocks while the queue is full; fails
    // fast with CircuitBreakerOpenError if too many consecutive 429s have
    // been reported. `release` only runs if acquire succeeds (via the
    // `ensuring` on the body below — if acquire throws, control exits
    // this gen before reaching the ensuring guard).
    yield* rateLimiter.acquire(
      input.teamID as TeamID,
      input.engineerID as EngineerID,
      "engineer",
      ENGINEER_TOKEN_ESTIMATE,
    )

    yield* Effect.gen(function* () {
      // Emit initial progress
      publishTeamEvent(Event.EngineerProgress, {
        teamID: input.teamID,
        engineerID: input.engineerID,
        progressText: `Starting: ${input.taskTitle.slice(0, 40)}${input.taskTitle.length > 40 ? "..." : ""}`,
        timestamp: Date.now(),
      })

      // Build teammates section if we have teammates
      const teammatesSection = input.teammates && input.teammates.length > 0
        ? [
            ``,
            `Your teammates:`,
            ...input.teammates.map((t) => `- ${t.name} (ID: ${t.engineerID})${t.task ? ` - working on: ${t.task}` : ""}`),
            `Use team_message with recipientID to collaborate with them.`,
          ]
        : []

      const engineerPrompt = [
        `You are an engineer on team ${input.teamID}. Your name is ${input.name}.`,
        ...teammatesSection,
        ``,
        `Your assigned task:`,
        `Title: ${input.taskTitle}`,
        `Description: ${input.taskDescription}`,
        ``,
        `Instructions:`,
        `1. Analyze the task and plan your approach`,
        `2. Execute the work using available tools (Read, Write, Edit, Bash, etc.)`,
        `3. Test your changes`,
        `4. Write your findings/report to a file: .tmp/report-${input.name}.md`,
        `5. IMPORTANT: When finished, call team_report with:`,
        `   - status: "completed" (or "blocked"/"failed" if issues)`,
        `   - summary: ONE sentence + path to report file (e.g., "Completed review. Report: .tmp/report-${input.name}.md")`,
        `   - DO NOT send full report content via team_report — keep summary under 200 chars`,
        `6. After reporting, you may check team_tasks for NEW unassigned work.`,
        `   - team_tasks only shows pending, unassigned tasks (NOT your completed task)`,
        `   - If NEW tasks are available, use team_claim to claim one and work on it.`,
        `   - If NO NEW tasks are available, STOP. Do not reclaim your completed task.`,
        ``,
        `Collaboration tools:`,
        `- team_message: Send message to a teammate or lead`,
        `- team_roster: See all teammates and their IDs`,
        `- team_tasks: List available tasks (only shows pending, unassigned tasks)`,
        `- team_claim: Claim an unassigned task`,
        ``,
        `Start working on your assigned task now. Remember to call team_report when done.`,
      ].join("\n")

      // Build model parameter if specified
      const modelParam = input.providerID && input.modelID
        ? { providerID: input.providerID, modelID: input.modelID }
        : undefined

      yield* promptService.prompt({
        sessionID: input.sessionID,
        parts: [{ type: "text", text: engineerPrompt }],
        model: modelParam,
      })
      log.info("engineer completed initial prompt", { engineerID: input.engineerID })

      // Emit working progress
      publishTeamEvent(Event.EngineerProgress, {
        teamID: input.teamID,
        engineerID: input.engineerID,
        progressText: `Working on: ${input.taskTitle.slice(0, 35)}${input.taskTitle.length > 35 ? "..." : ""}`,
        timestamp: Date.now(),
      })

      yield* promptService.loop({ sessionID: input.sessionID })
      log.info("engineer loop completed", { engineerID: input.engineerID })

      // The lead's running map is in a different process now (Phase 1).
      // deleteRunning here is a no-op when the loop runs in a subprocess
      // (the subprocess has its own empty map), but is kept so any
      // direct in-process callers (none today) still clean up.
      deleteRunning(input.teamID as TeamID, input.engineerID as EngineerID)
      publishTeamEvent(Event.EngineerCompleted, {
        teamID: input.teamID,
        engineerID: input.engineerID,
        taskId: input.taskId,
      })
    }).pipe(
      // Release the rate-limit slot on ANY exit of the body (success,
      // failure, or interruption). Errors from release itself are
      // swallowed — losing a slot is better than compounding a failure.
      // The outer acquire lives above this ensuring, so if acquire
      // itself fails, release never runs (correct).
      Effect.ensuring(
        rateLimiter
          .release(input.teamID as TeamID, input.engineerID as EngineerID, ENGINEER_TOKEN_ESTIMATE)
          .pipe(Effect.ignore),
      ),
    )
  })
