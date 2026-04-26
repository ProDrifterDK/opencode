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
import { MessageV2 } from "@/session/message-v2"
import * as Bus from "@/bus"
import { Event, publishTeamEvent } from "./events"
import { formatPartProgress } from "./engineer-progress"
import { RateLimiter } from "./rate-limiter"
import type { EngineerID, TeamID } from "./types"
import { deleteRunning } from "./daemon-running"
import { ProviderID, ModelID } from "@/provider/schema"

const log = Log.create({ service: "team.engineer-loop" })

/**
 * Subscribe to `MessageV2.Event.PartUpdated` for the given `sessionID` and
 * emit `EngineerProgress` events at most once per `debounceMs` milliseconds.
 *
 * Returns an unsubscribe function. Call it when the prompt finishes to
 * release the Bus subscription.
 *
 * This is designed to run inside the engineer subprocess where `Bus.subscribe`
 * is backed by the local process-level Bus (same process that runs the
 * SessionPrompt). Because `Bus.subscribe` is synchronous and callback-based
 * it does not need Effect fiber machinery — plain JS closure is sufficient.
 */
export function watchSessionProgress(
  sessionID: SessionID,
  teamID: string,
  engineerID: string,
  debounceMs = 1000,
): () => void {
  let lastEmitAt = 0
  let lastText: string | undefined

  // Track whether we have emitted a "Thinking..." for the current assistant
  // turn so we don't spam it on every text-delta event.
  let thinkingEmitted = false

  const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
    if (event.properties.sessionID !== sessionID) return

    const part = event.properties.part as MessageV2.Part
    let progressText = formatPartProgress(part)
    if (progressText === null) return

    // For Thinking, emit only once per turn (reset when a tool starts)
    if (progressText === "💭 Thinking...") {
      if (thinkingEmitted) return
      thinkingEmitted = true
    } else {
      // A tool started — reset the thinking guard so next text gets emitted
      thinkingEmitted = false
    }

    // Debounce: skip if within the window and text is unchanged
    const now = Date.now()
    if (progressText === lastText && now - lastEmitAt < debounceMs) return

    lastEmitAt = now
    lastText = progressText

    publishTeamEvent(Event.EngineerProgress, {
      teamID,
      engineerID,
      progressText,
      timestamp: now,
    })
  })

  return unsub
}

// Rough token estimate per engineer lifetime. Used only as a budget hint
// for the rate limiter's per-minute token window — the exact number matters
// less than the fact that we reserve *some* budget so N engineers can't
// spawn unlimited LLM traffic. After the loop completes, the actual usage
// from the final LLM response is reconciled via rateLimiter.reconcile().
export const ENGINEER_TOKEN_ESTIMATE = 8000

/**
 * Sum input + output tokens across all `step-finish` parts in a message.
 * Returns 0 when no step-finish parts are present (caller treats as no-op).
 *
 * Note: this captures only the tokens from the *final* assistant message
 * returned by promptService.loop. For multi-turn engineer sessions the
 * count is a partial view — it still beats the hard-coded estimate for the
 * common single-turn case and is better than nothing for multi-turn.
 */
export const extractTokensFromMessage = (msg: MessageV2.WithParts): number => {
  let total = 0
  for (const part of msg.parts) {
    if (part.type === "step-finish") {
      total += (part.tokens?.input ?? 0) + (part.tokens?.output ?? 0)
    }
  }
  return total
}

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
  /**
   * Fallback model. When the primary provider trips the team's circuit
   * breaker (3 consecutive 429s), the engineer-loop catches the
   * `CircuitBreakerOpenError`, swaps to this model, and retries the
   * task ONCE. If `fallbackProviderID/fallbackModelID` are absent or
   * the retry also trips the breaker, the loop fails through.
   */
  fallbackProviderID?: string
  fallbackModelID?: string
  teammates?: Array<{ name: string; engineerID: string; task?: string }>
}

/**
 * One attempt at the engineer task with a specific model. Acquires a
 * rate-limit slot, sends the engineer prompt, runs the prompt loop,
 * reconciles tokens, publishes completion. Releases the slot on any
 * exit. Throws `CircuitBreakerOpenError` if the team's breaker is
 * tripped at acquire-time — the outer `runEngineerLoop` catches that to
 * decide whether to swap to the fallback model.
 */
const attemptTask = (
  input: EngineerLoopInput,
  modelParam: { providerID: ProviderID; modelID: ModelID } | undefined,
  attemptLabel: "primary" | "fallback",
) =>
  Effect.gen(function* () {
    const rateLimiter = yield* RateLimiter.Service
    const promptService = yield* SessionPrompt.Service

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
      // Subscribe to live session part updates for sidebar progress.
      // The unsubscribe is called in the `ensuring` block below so it
      // fires on success, failure, and interruption.
      const unsubProgress = watchSessionProgress(
        input.sessionID,
        input.teamID,
        input.engineerID,
      )

      yield* Effect.gen(function* () {
        // Emit initial progress
        publishTeamEvent(Event.EngineerProgress, {
          teamID: input.teamID,
          engineerID: input.engineerID,
          progressText:
            attemptLabel === "fallback"
              ? `Retrying (fallback): ${input.taskTitle.slice(0, 30)}${input.taskTitle.length > 30 ? "..." : ""}`
              : `Starting: ${input.taskTitle.slice(0, 40)}${input.taskTitle.length > 40 ? "..." : ""}`,
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

        const retryNote = attemptLabel === "fallback"
          ? [
              `NOTE: Your previous attempt was interrupted because the primary provider hit a sustained 429 burst. You are now running on the fallback provider; pick up the task and complete it.`,
              ``,
            ]
          : []

        const engineerPrompt = [
          `You are an engineer on team ${input.teamID}. Your name is ${input.name}.`,
          ...teammatesSection,
          ``,
          ...retryNote,
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

        yield* promptService.prompt({
          sessionID: input.sessionID,
          parts: [{ type: "text", text: engineerPrompt }],
          model: modelParam,
        })
        log.info("engineer completed initial prompt", { engineerID: input.engineerID, attempt: attemptLabel })

        // Emit working progress
        publishTeamEvent(Event.EngineerProgress, {
          teamID: input.teamID,
          engineerID: input.engineerID,
          progressText: `Working on: ${input.taskTitle.slice(0, 35)}${input.taskTitle.length > 35 ? "..." : ""}`,
          timestamp: Date.now(),
        })

        const loopResult = yield* promptService.loop({ sessionID: input.sessionID })
        log.info("engineer loop completed", { engineerID: input.engineerID, attempt: attemptLabel })

        // Reconcile the rate-limiter token budget: replace the upfront estimate
        // with the actual tokens consumed by this engineer's session.
        // Best-effort — if token extraction or reconcile fails, engineer
        // completion still succeeds.
        yield* Effect.gen(function* () {
          const actualTokens = extractTokensFromMessage(loopResult)
          if (actualTokens > 0) {
            yield* rateLimiter.reconcile(
              input.teamID as TeamID,
              input.engineerID as EngineerID,
              ENGINEER_TOKEN_ESTIMATE,
              actualTokens,
            )
            log.info("token reconciliation applied", {
              engineerID: input.engineerID,
              estimated: ENGINEER_TOKEN_ESTIMATE,
              actual: actualTokens,
            })
          }
        }).pipe(Effect.ignore)

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
        // Tear down the live-progress subscription on any exit (success,
        // failure, interruption) of the prompt body.
        Effect.ensuring(Effect.sync(() => unsubProgress())),
      )
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

/**
 * Run the engineer loop end-to-end with optional one-shot failover.
 *
 * Try the primary model. If `acquire` throws `CircuitBreakerOpenError`
 * AND a fallback model is configured, reset the team breaker (the
 * working assumption is that the fallback uses a different provider, so
 * the prior 429s don't apply), then retry ONCE with the fallback model.
 * If the fallback also fails or no fallback is configured, the error
 * propagates to the daemon's failure path.
 */
export const runEngineerLoop = (input: EngineerLoopInput) =>
  Effect.gen(function* () {
    log.info("starting engineer loop", {
      engineerID: input.engineerID,
      sessionID: input.sessionID,
      model: input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : "(default)",
      fallback:
        input.fallbackProviderID && input.fallbackModelID
          ? `${input.fallbackProviderID}/${input.fallbackModelID}`
          : "(none)",
    })

    const primaryModel = input.providerID && input.modelID
      ? { providerID: ProviderID.make(input.providerID), modelID: ModelID.make(input.modelID) }
      : undefined
    const fallbackModel = input.fallbackProviderID && input.fallbackModelID
      ? { providerID: ProviderID.make(input.fallbackProviderID), modelID: ModelID.make(input.fallbackModelID) }
      : undefined

    return yield* attemptTask(input, primaryModel, "primary").pipe(
      Effect.catchTag("CircuitBreakerOpenError", (cbErr) =>
        Effect.gen(function* () {
          if (!fallbackModel) {
            log.info("no fallback configured — engineer fails through", {
              engineerID: input.engineerID,
            })
            return yield* Effect.fail(cbErr)
          }
          log.info("circuit breaker open — swapping to fallback model", {
            engineerID: input.engineerID,
            fallback: `${fallbackModel.providerID}/${fallbackModel.modelID}`,
          })
          // Reset the team's breaker. Assumption: the fallback uses a
          // different provider, so the breaker that was tripped by the
          // primary provider's 429s should not block the fallback.
          const rateLimiter = yield* RateLimiter.Service
          yield* rateLimiter.resetCircuitBreaker(input.teamID as TeamID)
          publishTeamEvent(Event.EngineerProgress, {
            teamID: input.teamID,
            engineerID: input.engineerID,
            progressText: `🔁 Swapping to fallback after circuit breaker`,
            timestamp: Date.now(),
          })
          // Retry once. Any error from the fallback attempt (CB open
          // again, anything else) propagates so the daemon marks the
          // engineer failed — we never loop fallbacks.
          return yield* attemptTask(input, fallbackModel, "fallback")
        }),
      ),
    )
  })
