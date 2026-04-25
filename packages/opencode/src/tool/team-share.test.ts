/**
 * Unit tests for the TeamShareTool execute logic.
 *
 * We cannot import from `../tool/team` directly because that module
 * transitively imports `app-runtime.ts`, which has a circular-init
 * `ReferenceError` at module-evaluation time in the test environment.
 *
 * Instead we reproduce the exact execute body inline and supply the same
 * service contracts via Effect layers — matching the pattern used in
 * team-commit-tool.test.ts.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as SessionCoordinatorService } from "../team/session-coordinator"
import { Service as SessionShareService } from "../share/session"
import type { SessionID } from "../session/schema"
import type { TeamID } from "../team/types"
import type { EngineerSlot, TeamRecord } from "../team/session-coordinator"

const LEAD_SESSION = "sess_lead" as SessionID
const OTHER_SESSION = "sess_other" as SessionID
const TEAM_ID = "team_001" as TeamID

// ─── Minimal service stubs ──────────────────────────────────────────────────

const makeCoordinatorStub = (
  leadSessionID: SessionID,
  team: TeamRecord | null,
  engineers: Partial<EngineerSlot>[],
): InstanceType<typeof SessionCoordinatorService> =>
  SessionCoordinatorService.of({
    createTeam: () => Effect.die("not implemented"),
    spawnEngineer: () => Effect.die("not implemented"),
    resumeEngineer: () => Effect.die("not implemented"),
    killEngineer: () => Effect.die("not implemented"),
    dissolveTeam: () => Effect.die("not implemented"),
    getTeam: () => Effect.succeed(team),
    getEngineer: () => Effect.succeed(null),
    getEngineerBySession: () => Effect.succeed(null),
    listTeamEngineers: () => Effect.succeed(engineers as EngineerSlot[]),
    listTeams: () => Effect.succeed([]),
    isLead: (sessionID: SessionID) => Effect.succeed(sessionID === leadSessionID),
    isEngineer: () => Effect.succeed(false),
    updateEngineer: () => Effect.void,
    getTeamForSession: () => Effect.succeed(null),
  } as any)

const makeShareStub = (
  shareFn: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>,
): InstanceType<typeof SessionShareService> =>
  SessionShareService.of({
    create: () => Effect.die("not implemented"),
    share: shareFn,
    unshare: () => Effect.void,
  })

// ─── The execute logic under test (mirrors TeamShareTool exactly) ───────────

const teamShareExecute = (params: { teamID: string }, sessionID: SessionID) =>
  Effect.gen(function* () {
    const coordinator = yield* SessionCoordinatorService
    const shareService = yield* SessionShareService

    const isLead = yield* coordinator.isLead(sessionID)
    if (!isLead) {
      return yield* Effect.fail(new Error("Only the team lead can share team transcripts"))
    }

    const teamID = params.teamID as TeamID
    const team = yield* coordinator.getTeam(teamID)
    if (!team) {
      return yield* Effect.fail(new Error(`Team ${params.teamID} not found`))
    }

    const engineers = yield* coordinator.listTeamEngineers(teamID)

    const leadResult = yield* shareService.share(team.leadSessionID)

    const engineerShares: { name: string; task: string | null; url: string }[] = []
    for (const eng of engineers) {
      const result = yield* shareService.share(eng.sessionID).pipe(
        Effect.catch((err: unknown) =>
          Effect.fail(new Error(`Failed to share engineer ${eng.name}: ${String(err)}`)),
        ),
      )
      engineerShares.push({ name: eng.name, task: eng.currentTask ?? null, url: result.url })
    }

    const lines: string[] = [
      `Team ${params.teamID} shared:`,
      `  Lead: ${leadResult.url}`,
      `  Engineers (${engineerShares.length}):`,
    ]
    for (const e of engineerShares) {
      const label = e.task ? `${e.name} (${e.task})` : e.name
      lines.push(`    ${label}: ${e.url}`)
    }

    return {
      title: `Share team ${params.teamID}`,
      output: lines.join("\n"),
      metadata: {
        teamID: params.teamID,
        leadURL: leadResult.url,
        engineers: engineerShares,
      },
    }
  })

// ─── Test runner ─────────────────────────────────────────────────────────────

const runWith = (
  sessionID: SessionID,
  teamID: string,
  team: TeamRecord | null,
  engineers: Partial<EngineerSlot>[],
  shareFn: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>,
  leadSessionID: SessionID = LEAD_SESSION,
) => {
  const coordLayer = Layer.succeed(
    SessionCoordinatorService,
    makeCoordinatorStub(leadSessionID, team, engineers),
  )
  const shareLayer = Layer.succeed(SessionShareService, makeShareStub(shareFn))
  const testLayer = Layer.merge(coordLayer, shareLayer)
  return Effect.provide(teamShareExecute({ teamID }, sessionID), testLayer).pipe(
    Effect.runPromise,
  )
}

// ─── Test data helpers ───────────────────────────────────────────────────────

const makeTeam = (leadSessionID: SessionID = LEAD_SESSION): TeamRecord => ({
  teamID: TEAM_ID,
  state: "active",
  leadSessionID,
  engineerCount: 0,
  createdAt: 0,
  updatedAt: 0,
})

const makeEngineer = (
  id: string,
  sessionID: string,
  name: string,
  task: string | null = null,
): Partial<EngineerSlot> => ({
  engineerID: id as any,
  sessionID: sessionID as SessionID,
  name,
  currentTask: task,
  state: "working",
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TeamShareTool execute", () => {
  // 1. Lead with no engineers — returns single Lead URL
  test("lead with no engineers: returns lead URL only", async () => {
    const team = makeTeam()
    const shareCalls: SessionID[] = []
    const result = await runWith(
      LEAD_SESSION,
      TEAM_ID,
      team,
      [],
      (sid) =>
        Effect.sync(() => {
          shareCalls.push(sid)
          return { url: `https://share.opencode.ai/${sid}` }
        }),
    )

    expect(shareCalls).toHaveLength(1)
    expect(shareCalls[0]).toBe(LEAD_SESSION)
    expect(result.metadata.leadURL).toBe(`https://share.opencode.ai/${LEAD_SESSION}`)
    expect(result.metadata.engineers).toHaveLength(0)
    expect(result.output).toContain(`Lead: https://share.opencode.ai/${LEAD_SESSION}`)
    expect(result.output).toContain("Engineers (0):")
  })

  // 2. Lead with 2 engineers — returns Lead URL + 2 engineer URLs
  test("lead with 2 engineers: returns lead URL and both engineer URLs", async () => {
    const team = makeTeam()
    const engineers = [
      makeEngineer("eng-a", "sess_eng_a", "engineer-auth", "Implement auth"),
      makeEngineer("eng-b", "sess_eng_b", "engineer-api", null),
    ]
    const shareCalls: SessionID[] = []
    const result = await runWith(
      LEAD_SESSION,
      TEAM_ID,
      team,
      engineers,
      (sid) =>
        Effect.sync(() => {
          shareCalls.push(sid)
          return { url: `https://share.opencode.ai/${sid}` }
        }),
    )

    expect(shareCalls).toHaveLength(3)
    expect(shareCalls[0]).toBe(LEAD_SESSION)
    expect(shareCalls[1]).toBe("sess_eng_a" as SessionID)
    expect(shareCalls[2]).toBe("sess_eng_b" as SessionID)

    expect(result.metadata.leadURL).toBe(`https://share.opencode.ai/${LEAD_SESSION}`)
    expect(result.metadata.engineers).toHaveLength(2)
    expect(result.metadata.engineers[0].url).toBe("https://share.opencode.ai/sess_eng_a")
    expect(result.metadata.engineers[1].url).toBe("https://share.opencode.ai/sess_eng_b")

    // Task label shows up when task is present
    expect(result.output).toContain("engineer-auth (Implement auth):")
    // No task — just name
    expect(result.output).toContain("engineer-api:")
    expect(result.output).toContain("Engineers (2):")
  })

  // 3. Non-lead caller — rejected
  test("non-lead session: fails with lead-only error", async () => {
    const team = makeTeam()
    await expect(
      runWith(OTHER_SESSION, TEAM_ID, team, [], () => Effect.succeed({ url: "https://x" })),
    ).rejects.toThrow("Only the team lead can share team transcripts")
  })

  // 4. Team not found — error
  test("team not found: fails with team not found error", async () => {
    await expect(
      runWith(LEAD_SESSION, "team_missing", null, [], () => Effect.succeed({ url: "https://x" })),
    ).rejects.toThrow("Team team_missing not found")
  })
})
